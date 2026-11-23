import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { ExtraButtonComponent } from "obsidian";
import type CopilotPlugin from "./main";
import { DEFAULT_SETTINGS, Placement } from "./constants";
import { PromptDef, PromptConstants, clampReadyDelay, newPrompt, promptsEqual, runnablePrompts } from "./prompts";

export class CopilotSettingTab extends PluginSettingTab {
  plugin: CopilotPlugin;
  private promptDraft: PromptDef[] = [];
  private editingPromptIds = new Set<string>();
  private busyPromptIds = new Set<string>();
  private promptConstantsSaveQueue: Promise<void> = Promise.resolve();
  private promptsEl: HTMLElement | null = null;

  constructor(app: App, plugin: CopilotPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Copilot Terminal" });

    new Setting(containerEl)
      .setName("Default placement")
      .setDesc("Where Copilot opens when you click the ribbon icon")
      .addDropdown((drop) =>
        drop
          .addOptions({
            right: "Right sidebar",
            left: "Left sidebar",
            bottom: "Bottom pane",
            tab: "New tab",
            split: "Split pane",
          })
          .setValue(this.plugin.settings.defaultPlacement)
          .onChange(async (value) => {
            this.plugin.settings.defaultPlacement = value as Placement;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-open on vault load")
      .setDesc("Automatically open Copilot when Obsidian starts")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoOpen)
          .onChange(async (value) => {
            this.plugin.settings.autoOpen = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Copilot CLI flags")
      .setDesc("Flags passed to the copilot command (e.g. --banner). Avoid --yolo: it skips tool confirmations.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.copilotFlags)
          .setValue(this.plugin.settings.copilotFlags)
          .onChange(async (value) => {
            this.plugin.settings.copilotFlags = value || DEFAULT_SETTINGS.copilotFlags;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Copilot executable path")
      .setDesc(
        "Optional. Absolute path to the copilot launcher (e.g. copilot.cmd). Leave blank to auto-detect. Set this if launching fails with 'copilot is not recognized'."
      )
      .addText((text) =>
        text
          .setPlaceholder("auto-detect")
          .setValue(this.plugin.settings.copilotPath)
          .onChange(async (value) => {
            this.plugin.settings.copilotPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("'vault' uses the vault root, or enter a custom absolute path")
      .addText((text) =>
        text
          .setPlaceholder("vault")
          .setValue(this.plugin.settings.workingDirectory)
          .onChange(async (value) => {
            this.plugin.settings.workingDirectory = value || "vault";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h2", { text: "Terminal" });

    new Setting(containerEl)
      .setName("Sync font with Obsidian theme")
      .setDesc("Use the theme's monospace font and text size in the terminal. Off keeps the built-in font and size.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncObsidianFont)
          .onChange(async (value) => {
            this.plugin.settings.syncObsidianFont = value;
            await this.plugin.saveSettings();
            this.plugin.refreshTerminalFont();
          })
      );

    new Setting(containerEl)
      .setName("Open links only from the right-click menu")
      .setDesc("Left-clicking a link in the terminal does nothing. Right-click a link to copy it or open it in the browser or Obsidian's Web viewer.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.blockLinkClick)
          .onChange(async (value) => {
            this.plugin.settings.blockLinkClick = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h2", { text: "Integrations" });

    new Setting(containerEl)
      .setName("IDE integration")
      .setDesc(
        "Let the Copilot CLI's /ide command see Obsidian's active file and text selection. Turn this off if the CLI is slow to start or won't load, then reload."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableIdeIntegration)
          .onChange(async (value) => {
            this.plugin.settings.enableIdeIntegration = value;
            await this.plugin.saveSettings();
            await this.plugin.setIdeIntegration(value);
          })
      );

    new Setting(containerEl)
      .setName("Auto-connect IDE on start")
      .setDesc(
        "Automatically run /ide when the terminal starts so the CLI connects to Obsidian without typing it. Only applies when IDE integration is on."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoConnectIde)
          .onChange(async (value) => {
            this.plugin.settings.autoConnectIde = value;
            await this.plugin.saveSettings();
          })
      );

    this.promptDraft = this.clonePrompts(this.plugin.settings.prompts);
    this.editingPromptIds.clear();
    this.promptsEl = containerEl.createDiv();
    this.renderPrompts();

    containerEl.createEl("h2", { text: "Session" });

    new Setting(containerEl)
      .setName("Persistent session")
      .setDesc(
        "Always resume the same Copilot session. A unique session ID is generated on first use and reused on every launch."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.persistentSession)
          .onChange(async (value) => {
            this.plugin.settings.persistentSession = value;
            if (value && !this.plugin.getMachineSessionId()) {
              this.plugin.setMachineSessionId(require("crypto").randomUUID());
            }
            await this.plugin.saveSettings();
          })
      );
  }
  private clonePrompts(list: PromptDef[]): PromptDef[] {
    return list.map((p) => ({ ...p }));
  }

  private renderPrompts(): void {
    const el = this.promptsEl;
    if (!el) return;
    el.empty();
    el.createEl("h2", { text: "Prompts" });
    el.createEl("p", {
      cls: "setting-item-description",
      text:
        "Each active prompt with a name and text appears in the command palette as \"Copilot CLI: Prompt: <name>\". " +
        "It is pasted into the open Copilot window, or into a new tab with a fresh session.",
    });

    this.renderPromptConstants(el);

    new Setting(el)
      .setName("CLI ready delay (ms)")
      .setDesc(
        "How long the CLI output must stay quiet after a new session starts before the prompt is sent. Increase it if the CLI starts slowly and the prompt arrives too early. 500-60000."
      )
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.promptReadyDelayMs))
          .onChange(async (v) => {
            this.plugin.settings.promptReadyDelayMs = clampReadyDelay(v);
            await this.plugin.saveSettings();
          })
      );

    this.promptDraft.forEach((p) => {
      const saved = this.plugin.settings.prompts.find((item) => item.id === p.id);
      const editing = this.editingPromptIds.has(p.id);
      const busy = this.busyPromptIds.has(p.id);
      const row = el.createDiv({ cls: "copilot-prompt-row" });
      const head = row.createDiv({ cls: "copilot-prompt-head" });
      const name = head.createEl("input", {
        type: "text",
        placeholder: "Name",
        cls: "copilot-prompt-name",
        attr: { "aria-label": "Prompt name" },
      });
      name.value = p.name;
      name.readOnly = !editing || busy;

      let revertButton: ExtraButtonComponent | null = null;
      let saveButton: ExtraButtonComponent | null = null;
      new Setting(head)
        .addExtraButton((b) => {
          revertButton = b;
          b.setIcon("rotate-ccw").setTooltip("Revert prompt");
          b.setDisabled(!editing || busy || (!!saved && promptsEqual([p], [saved])));
          b.onClick(() => this.revertPrompt(p.id));
        })
        .addExtraButton((b) => {
          saveButton = b;
          b.setIcon("save").setTooltip("Save prompt");
          b.setDisabled(!editing || busy || (!!saved && promptsEqual([p], [saved])));
          b.onClick(() => void this.savePrompt(p.id));
        })
        .addExtraButton((b) => {
          b.setIcon("pencil").setTooltip("Edit prompt");
          b.setDisabled(editing || busy);
          b.onClick(() => this.editPrompt(p.id));
        })
        .addExtraButton((b) => {
          b.setIcon("trash").setTooltip("Delete prompt");
          b.setDisabled(busy);
          b.onClick(() => void this.deletePrompt(p.id));
        });

      const refreshActions = () => {
        const dirty = !saved || !promptsEqual([p], [saved]);
        revertButton?.setDisabled(!editing || busy || !dirty);
        saveButton?.setDisabled(!editing || busy || !dirty);
      };
      name.addEventListener("input", () => {
        p.name = name.value;
        refreshActions();
      });

      const text = row.createEl("textarea", {
        placeholder: "Prompt text",
        attr: { rows: "3", "aria-label": "Prompt text" },
      });
      text.value = p.text;
      text.readOnly = !editing || busy;
      text.addEventListener("input", () => {
        p.text = text.value;
        refreshActions();
      });

      const flags = row.createDiv({ cls: "copilot-prompt-flags" });
      const flag = (label: string, key: "newSession" | "sendImmediately" | "isActive") => {
        const l = flags.createEl("label");
        const cb = l.createEl("input", { type: "checkbox" });
        cb.checked = p[key];
        cb.disabled = !editing || busy;
        cb.addEventListener("change", () => {
          p[key] = cb.checked;
          refreshActions();
        });
        l.appendText(" " + label);
      };
      flag("Always new session", "newSession");
      flag("Send immediately (Enter)", "sendImmediately");
      flag("Active", "isActive");
    });

    const addPrompt = el.createDiv({ cls: "copilot-prompt-actions" });
    new Setting(addPrompt)
      .addButton((b) => {
        b.setButtonText("Add prompt").onClick(() => {
          const prompt = newPrompt(require("crypto").randomUUID());
          this.promptDraft.push(prompt);
          this.editingPromptIds.add(prompt.id);
          this.renderPrompts();
        });
      });
  }

  private renderPromptConstants(container: HTMLElement): void {
    const section = container.createDiv({ cls: "copilot-prompt-constants" });
    section.createEl("h3", { text: "Constants" });
    section.createEl("p", {
      cls: "setting-item-description",
      text: "Use %name% in a prompt. %current-doc-path% inserts the active Markdown file path from the vault root.",
    });

    for (const [name, value] of Object.entries(this.plugin.settings.promptConstants)) {
      const row = section.createDiv({ cls: "copilot-constant-row" });
      const nameInput = row.createEl("input", {
        type: "text",
        placeholder: "Name",
        attr: { "aria-label": "Constant name" },
      });
      nameInput.value = name;
      const valueInput = row.createEl("textarea", {
        placeholder: "Value",
        attr: { rows: "2", "aria-label": "Constant value" },
      });
      valueInput.value = value;
      let currentName = name;

      const save = () => {
        this.queuePromptConstantsSave(async () => {
          const nextName = nameInput.value.trim();
          const current = this.plugin.settings.promptConstants;
          if (
            !nextName ||
            nextName.includes("%") ||
            nextName === "current-doc-path" ||
            (nextName !== currentName && Object.prototype.hasOwnProperty.call(current, nextName))
          ) {
            nameInput.value = currentName;
            new Notice("Constant names must be unique and cannot use % or current-doc-path.");
            return;
          }
          if (nextName === currentName && current[currentName] === valueInput.value) return;

          const previous = current;
          const next = this.clonePromptConstants(current);
          delete next[currentName];
          next[nextName] = valueInput.value;
          this.plugin.settings.promptConstants = next;
          try {
            await this.plugin.saveSettings();
            currentName = nextName;
          } catch (error) {
            this.plugin.settings.promptConstants = previous;
            console.error("Copilot CLI: Failed to save prompt constant", error);
            nameInput.value = currentName;
            valueInput.value = previous[currentName] ?? "";
            new Notice("Could not save constant.");
          }
        });
      };
      nameInput.addEventListener("change", () => void save());
      valueInput.addEventListener("change", () => void save());

      new Setting(row).addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Delete constant").onClick(() =>
          this.queuePromptConstantsSave(() => this.deletePromptConstant(currentName))
        )
      );
    }

    new Setting(section).addButton((b) =>
      b.setButtonText("Add constant").onClick(() =>
        this.queuePromptConstantsSave(() => this.addPromptConstant())
      )
    );
  }

  private queuePromptConstantsSave(operation: () => Promise<void>): void {
    this.promptConstantsSaveQueue = this.promptConstantsSaveQueue.then(operation);
  }

  private clonePromptConstants(constants: PromptConstants): PromptConstants {
    const clone = Object.create(null) as PromptConstants;
    for (const [name, value] of Object.entries(constants)) clone[name] = value;
    return clone;
  }

  private async addPromptConstant(): Promise<void> {
    const previous = this.plugin.settings.promptConstants;
    const next = this.clonePromptConstants(previous);
    let index = 1;
    while (Object.prototype.hasOwnProperty.call(next, `constant-${index}`)) index++;
    next[`constant-${index}`] = "";
    this.plugin.settings.promptConstants = next;
    try {
      await this.plugin.saveSettings();
    } catch (error) {
      this.plugin.settings.promptConstants = previous;
      console.error("Copilot CLI: Failed to add prompt constant", error);
      new Notice("Could not add constant.");
      return;
    }
    this.renderPrompts();
  }

  private async deletePromptConstant(name: string): Promise<void> {
    const previous = this.plugin.settings.promptConstants;
    const next = this.clonePromptConstants(previous);
    delete next[name];
    this.plugin.settings.promptConstants = next;
    try {
      await this.plugin.saveSettings();
    } catch (error) {
      this.plugin.settings.promptConstants = previous;
      console.error("Copilot CLI: Failed to delete prompt constant", error);
      new Notice("Could not delete constant.");
      return;
    }
    this.renderPrompts();
  }

  private editPrompt(id: string): void {
    const saved = this.plugin.settings.prompts.find((p) => p.id === id);
    if (saved) {
      const index = this.promptDraft.findIndex((p) => p.id === id);
      if (index >= 0) this.promptDraft[index] = { ...saved };
    }
    this.editingPromptIds.add(id);
    this.renderPrompts();
  }

  private revertPrompt(id: string): void {
    const saved = this.plugin.settings.prompts.find((p) => p.id === id);
    if (saved) {
      const index = this.promptDraft.findIndex((p) => p.id === id);
      if (index >= 0) this.promptDraft[index] = { ...saved };
    } else {
      this.promptDraft = this.promptDraft.filter((p) => p.id !== id);
    }
    this.editingPromptIds.delete(id);
    this.renderPrompts();
  }

  private async savePrompt(id: string): Promise<void> {
    if (this.busyPromptIds.has(id)) return;
    const draft = this.promptDraft.find((p) => p.id === id);
    if (!draft) return;

    this.busyPromptIds.add(id);
    this.renderPrompts();
    const previous = this.plugin.settings.prompts;
    const saved = { ...draft };
    const exists = previous.some((p) => p.id === id);
    this.plugin.settings.prompts = exists
      ? previous.map((p) => (p.id === id ? saved : p))
      : [...previous, saved];
    try {
      await this.plugin.saveSettings();
    } catch (error) {
      this.plugin.settings.prompts = previous;
      console.error("Copilot CLI: Failed to save prompt", error);
      new Notice("Could not save prompt.");
      this.busyPromptIds.delete(id);
      this.renderPrompts();
      return;
    }

    const index = this.promptDraft.findIndex((p) => p.id === id);
    if (index >= 0) this.promptDraft[index] = saved;
    this.editingPromptIds.delete(id);
    this.busyPromptIds.delete(id);
    this.plugin.registerPromptCommands();
    this.renderPrompts();
    new Notice("Prompt saved.");
  }

  private async deletePrompt(id: string): Promise<void> {
    if (this.busyPromptIds.has(id)) return;
    const previous = this.plugin.settings.prompts;
    if (!previous.some((p) => p.id === id)) {
      this.promptDraft = this.promptDraft.filter((p) => p.id !== id);
      this.editingPromptIds.delete(id);
      this.renderPrompts();
      return;
    }

    this.busyPromptIds.add(id);
    this.renderPrompts();
    this.plugin.settings.prompts = previous.filter((p) => p.id !== id);
    try {
      await this.plugin.saveSettings();
    } catch (error) {
      this.plugin.settings.prompts = previous;
      console.error("Copilot CLI: Failed to delete prompt", error);
      new Notice("Could not delete prompt.");
      this.busyPromptIds.delete(id);
      this.renderPrompts();
      return;
    }

    this.promptDraft = this.promptDraft.filter((p) => p.id !== id);
    this.editingPromptIds.delete(id);
    this.busyPromptIds.delete(id);
    this.plugin.registerPromptCommands();
    this.renderPrompts();
  }
}
