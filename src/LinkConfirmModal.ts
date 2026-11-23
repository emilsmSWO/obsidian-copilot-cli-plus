import { App, Modal } from "obsidian";

/** Warns about opening an external link and asks what to do. Closing or Cancel does nothing. */
export function confirmLink(app: App, url: string, open: () => void, copy: () => void): void {
  const modal = new Modal(app);
  modal.titleEl.setText("⚠ Warning: open external link?");
  const warning = modal.contentEl.createEl("p", {
    text: "This link leads to an external site and could be dangerous (phishing, malware, unwanted downloads). Open it only if you trust the source.",
  });
  warning.setCssStyles({ color: "var(--text-error)" });
  modal.contentEl.createEl("p", { text: url }).setCssStyles({ wordBreak: "break-all" });
  const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
  buttons.createEl("button", { text: "Open", cls: "mod-warning" }).onclick = () => {
    modal.close();
    open();
  };
  buttons.createEl("button", { text: "Copy Hyperlink" }).onclick = () => {
    modal.close();
    copy();
  };
  buttons.createEl("button", { text: "Cancel", cls: "mod-cta" }).onclick = () => modal.close();
  modal.open();
}
