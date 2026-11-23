import { App, Modal } from "obsidian";

/** Asks what to do with a clicked terminal link. Closing or Cancel does nothing. */
export function confirmLink(app: App, url: string, open: () => void, copy: () => void): void {
  const modal = new Modal(app);
  modal.titleEl.setText("Open link?");
  modal.contentEl.createEl("p", { text: url }).setCssStyles({ wordBreak: "break-all" });
  const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
  buttons.createEl("button", { text: "Open", cls: "mod-cta" }).onclick = () => {
    modal.close();
    open();
  };
  buttons.createEl("button", { text: "Copy Hyperlink" }).onclick = () => {
    modal.close();
    copy();
  };
  buttons.createEl("button", { text: "Cancel" }).onclick = () => modal.close();
  modal.open();
}
