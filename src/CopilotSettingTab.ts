import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CopilotPlugin from "./main";
import { DEFAULT_SETTINGS, Placement } from "./constants";
import { PromptDef, newPrompt, promptsEqual, runnablePrompts } from "./prompts";

export class CopilotSettingTab extends PluginSettingTab {
  plugin: CopilotPlugin;
  /** Working copy of the prompts; only written to settings by "Save changes" */
  private draft: PromptDef[] = [];
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

    this.draft = this.clonePrompts(this.plugin.settings.prompts);
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

    const dirty = !promptsEqual(this.draft, this.plugin.settings.prompts);

    this.draft.forEach((p, i) => {
      const row = el.createDiv({ cls: "copilot-prompt-row" });
      const head = row.createDiv({ cls: "copilot-prompt-head" });
      const name = head.createEl("input", { type: "text", placeholder: "Name" });
      name.value = p.name;
      name.addEventListener("input", () => { p.name = name.value; this.refreshButtons(); });
      new Setting(head).addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Delete prompt").onClick(() => {
          this.draft.splice(i, 1);
          this.renderPrompts();
        })
      );

      const text = row.createEl("textarea", { placeholder: "Prompt text", attr: { rows: "3" } });
      text.value = p.text;
      text.addEventListener("input", () => { p.text = text.value; this.refreshButtons(); });

      const flags = row.createDiv({ cls: "copilot-prompt-flags" });
      const flag = (label: string, key: "newSession" | "sendImmediately" | "isActive") => {
        const l = flags.createEl("label");
        const cb = l.createEl("input", { type: "checkbox" });
        cb.checked = p[key];
        cb.addEventListener("change", () => { p[key] = cb.checked; this.refreshButtons(); });
        l.appendText(" " + label);
      };
      flag("Always new session", "newSession");
      flag("Send immediately (Enter)", "sendImmediately");
      flag("Active", "isActive");
    });

    const actions = el.createDiv({ cls: "copilot-prompt-actions" });
    new Setting(actions)
      .addButton((b) =>
        b.setButtonText("Add prompt").onClick(() => {
          this.draft.push(newPrompt(require("crypto").randomUUID()));
          this.renderPrompts();
        })
      )
      .addButton((b) => {
        b.setButtonText("Save changes").setCta().setDisabled(!dirty).onClick(() => this.savePrompts());
        b.buttonEl.addClass("copilot-prompt-save");
      })
      .addButton((b) => {
        b.setButtonText("Revert changes").setDisabled(!dirty).onClick(() => {
          this.draft = this.clonePrompts(this.plugin.settings.prompts);
          this.renderPrompts();
        });
        b.buttonEl.addClass("copilot-prompt-revert");
      });
  }

  /** Enable/disable Save and Revert without re-rendering (keeps input focus while typing) */
  private refreshButtons(): void {
    const dirty = !promptsEqual(this.draft, this.plugin.settings.prompts);
    this.promptsEl?.querySelectorAll<HTMLButtonElement>(".copilot-prompt-save, .copilot-prompt-revert")
      .forEach((b) => { b.disabled = !dirty; });
  }

  private async savePrompts(): Promise<void> {
    this.plugin.settings.prompts = this.clonePrompts(this.draft);
    await this.plugin.saveSettings();
    this.plugin.registerPromptCommands();
    const skipped = this.draft.filter((p) => p.isActive).length - runnablePrompts(this.draft).length;
    new Notice(
      skipped > 0
        ? `Prompts saved. ${skipped} active prompt(s) without a name or text have no command.`
        : "Prompts saved."
    );
    this.renderPrompts();
  }
}
