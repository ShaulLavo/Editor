import { el } from "./dom.ts";

export type TopBar = {
  readonly element: HTMLDivElement;
  readonly openButton: HTMLButtonElement;
  readonly refreshButton: HTMLButtonElement;
  setDirectoryName(name: string): void;
  setMessage(message: string): void;
  setBusyState(isBusy: boolean, hasDirectory: boolean): void;
};

export function createTopBar(): TopBar {
  const element = el("div", { id: "toolbar" });
  const openButton = el("button", { id: "open-btn" });
  openButton.textContent = "Open Directory";

  const refreshButton = el("button", { id: "refresh-btn", title: "Refresh file tree" });
  refreshButton.textContent = "Refresh";
  refreshButton.disabled = true;

  const directoryName = el("span", { id: "dir-name" });
  element.append(openButton, refreshButton, directoryName);

  return {
    element,
    openButton,
    refreshButton,
    setDirectoryName: (name) => {
      directoryName.textContent = name;
    },
    setMessage: (message) => {
      directoryName.textContent = message;
    },
    setBusyState: (isBusy, hasDirectory) => {
      openButton.disabled = isBusy;
      refreshButton.disabled = isBusy || !hasDirectory;
    },
  };
}
