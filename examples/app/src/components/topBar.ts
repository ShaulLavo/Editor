import { el } from "./dom.ts";

export type TopBar = {
  readonly element: HTMLDivElement;
  readonly openButton: HTMLButtonElement;
  readonly refreshButton: HTMLButtonElement;
  setDirectoryName(name: string): void;
  setMessage(message: string): void;
  setBusyState(isBusy: boolean, hasDirectory: boolean): void;
};

class TopBarController implements TopBar {
  readonly element = el("div", { id: "toolbar" });
  readonly openButton = el("button", { id: "open-btn" });
  readonly refreshButton = el("button", { id: "refresh-btn", title: "Refresh file tree" });
  private readonly directoryName = el("span", { id: "dir-name" });

  constructor() {
    this.openButton.textContent = "Open Directory";
    this.refreshButton.textContent = "Refresh";
    this.refreshButton.disabled = true;
    this.element.append(this.openButton, this.refreshButton, this.directoryName);
  }

  setDirectoryName(name: string): void {
    this.directoryName.textContent = name;
  }

  setMessage(message: string): void {
    this.directoryName.textContent = message;
  }

  setBusyState(isBusy: boolean, hasDirectory: boolean): void {
    this.openButton.disabled = isBusy;
    this.refreshButton.disabled = isBusy || !hasDirectory;
  }
}

export function createTopBar(): TopBar {
  return new TopBarController();
}
