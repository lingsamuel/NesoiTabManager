// Functions

declare function getAllTabs();

// DS-s

type WindowType = "normal" | "popup" | "devtools";

type WindowState = "normal" | "minimized" | "maximized" | "fullscreen";

type BrowserWindow = {
    id?: number, // use sessionId when queried in session API
    focused: boolean,
    top?: number, // does not exists when queried in session API
    left?: number, // does not exists when queried in session API
    width?: number, // does not exists when queried in session API
    height?: number, // does not exists when queried in session API
    tabs: Array<Tab>,
    incognito: boolean,
    type?: WindowType, // does not exists when queried in session API
    state?: WindowState, // does not exists when queried in session API
    alwaysOnTop: boolean,
    sessionId: string, // obtained from session API
}

type Tab = {
    id?: number, // chrome.tabs.TAB_ID_NONE for App and DevTool
    index: number,
    windowId: number,
    openerTabId?: number, // Opener Tab id, if it still exists
    highlighted: boolean,
    active: boolean, // Is active in it's Window
    pinned: boolean,
    audible?: boolean, // If this page produce audio (keep value even if muted)
    discarded: boolean, // Unload from memory (Suspended)
    autoDiscardable: boolean, // If this page audio can be unload from memory
    mutedInfo?: MutedInfo,
    url?: string, // Last committed url
    pendingUrl?: string, // Committing url
    title: string, // Not optional while *Nesoi* has "tabs" permission
    favIconUrl: string, // Empty if loading
    status?: TabStatus,
    incognito: boolean,
    width?: number, // pixel
    height?: number, // pixel
    sessionId?: string
}
type TabStatus = "unloaded" | "loading" | "complete";
type MutedInfoReason = "user" | "capture" | "extension";
type MutedInfo = {
    muted: boolean,
    reason: MutedInfoReason, // Who changes the muted state
    extensionId: string, // If changed by extension, the ext id
}
