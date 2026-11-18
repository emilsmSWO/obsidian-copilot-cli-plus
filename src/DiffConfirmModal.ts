import { App, Modal } from "obsidian";

const PREVIEW_CHARS = 5000;

/** Asks the user to approve a file write requested by the CLI. Closing = reject. */
export function confirmWrite(app: App, relPath: string, contents: string): Promise<boolean> {
  return new Promise((resolve) => {
    let accepted = false;
    const modal = new Modal(app);
    modal.titleEl.setText("Copilot CLI wants to write a file");
    modal.contentEl.createEl("p", { text: relPath });
    modal.contentEl.createEl("pre", {
      text: contents.length > PREVIEW_CHARS ? `${contents.slice(0, PREVIEW_CHARS)}\n… (${contents.length} chars total)` : contents,
    }).setCssStyles({ maxHeight: "300px", overflow: "auto" });
    const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Accept", cls: "mod-cta" }).onclick = () => {
      accepted = true;
      modal.close();
    };
    buttons.createEl("button", { text: "Reject" }).onclick = () => modal.close();
    modal.onClose = () => resolve(accepted);
    modal.open();
  });
}
