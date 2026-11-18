/** In-window docking for Zotero's existing tab-content nodes. */
type Edge = "left" | "right" | "top" | "bottom";
type Rect = { x: number; y: number; w: number; h: number };
type Leaf = { kind: "leaf"; id: string; tabs: string[]; active: string };
type Branch = { kind: "branch"; axis: "horizontal" | "vertical"; ratio: number; first: Node; second: Node };
type Node = Leaf | Branch;

interface TabsHost {
  _tabs: Array<{ id: string; title: string; type: string }>;
  selectedID: string;
  select: (...args: any[]) => any;
  add: (...args: any[]) => any;
  close: (...args: any[]) => any;
  move?: (id: string, index: number) => void;
  canUnload: (id: string) => boolean;
}

const XHTML = "http://www.w3.org/1999/xhtml";
const BAR = 36;
const HANDLE = 6;
const TAB_TYPE = "application/x-minimal-dock-tab";

function splitBounds(axis: Branch["axis"], ratio: number, { x, y, w, h }: Rect): [Rect, Rect] {
  const horizontal = axis === "horizontal";
  const total = horizontal ? w : h;
  const lower = Math.min(0.5, (horizontal ? 240 : 180) / Math.max(1, total));
  const first = Math.round(total * Math.max(lower, Math.min(1 - lower, ratio)));
  return horizontal
    ? [{ x, y, w: first, h }, { x: x + first, y, w: w - first, h }]
    : [{ x, y, w, h: first }, { x, y: y + first, w, h: h - first }];
}

function withoutLeaf(node: Node, source: Leaf): Node | null {
  if (node.kind === "leaf") return node === source ? null : node;
  const first = withoutLeaf(node.first, source);
  const second = withoutLeaf(node.second, source);
  return first && second ? { ...node, first, second } : first ?? second;
}

function boundsOf(node: Node, target: Leaf, rect: Rect): Rect | undefined {
  if (node.kind === "leaf") return node === target ? rect : undefined;
  const [first, second] = splitBounds(node.axis, node.ratio, rect);
  return boundsOf(node.first, target, first) ?? boundsOf(node.second, target, second);
}

export function installDock(win: any): () => void {
  const doc: Document = win.document;
  const tabs: TabsHost = win.Zotero_Tabs;
  const deck = doc.getElementById("tabs-deck") as HTMLElement;
  const stack = doc.getElementById("zotero-pane-stack") as HTMLElement;
  const titleBar = doc.getElementById("zotero-title-bar") as HTMLElement | null;
  const nativeTabBar = doc.getElementById("tab-bar-container") as HTMLElement | null;
  const nativeToolbar = doc.getElementById("zotero-tabs-toolbar") as HTMLElement | null;
  let nativeTabList = doc.querySelector("#tab-bar-container .tab-bar-inner-container") as HTMLElement | null;
  if (!tabs || !deck || !stack) return () => {};

  let root: Node | null = null;
  let serial = 0;
  let disposed = false;
  let mutating = false;
  let dragID: string | null = null;
  let lastSelectedID = tabs.selectedID;
  let splitterDrag: { node: Branch; pointerId: number; start: number; latest: number; initial: number; total: number; lower: number; horizontal: boolean; frame: number | null; timer: number | null } | null = null;
  const bars = new Map<string, { element: HTMLElement; signature: string }>();
  const savedStyles = new Map<Element, string | null>();
  const original = {
    select: tabs.select,
    add: tabs.add,
    close: tabs.close,
    canUnload: tabs.canUnload,
  };
  const previousDock = win.Zotero?.MinimalDock?.data?.dock;
  const overlay = doc.createElementNS(XHTML, "div") as HTMLElement;
  overlay.id = "minimal-dock-overlay";
  overlay.dataset.minimalDockRoot = "true";
  overlay.style.cssText = "position:absolute;z-index:30;pointer-events:none;overflow:hidden;";
  const handles = doc.createElementNS(XHTML, "div") as HTMLElement;
  handles.style.cssText = "position:absolute;inset:0;z-index:2;pointer-events:none;";
  overlay.appendChild(handles);
  stack.appendChild(overlay);
  const splitterShield = doc.createElementNS(XHTML, "div") as HTMLElement;
  splitterShield.style.cssText = "position:absolute;z-index:31;display:none;pointer-events:auto;cursor:col-resize;touch-action:none;";
  stack.appendChild(splitterShield);
  const css = doc.createElementNS(XHTML, "style") as HTMLStyleElement;
  css.textContent = `
    #tabs-deck.minimal-dock-active { display: block !important; position: relative !important; min-width: 0 !important; overflow: hidden !important; }
    #tabs-deck.minimal-dock-active > tab-content { -moz-subtree-hidden-only-visually: 0 !important; position: absolute !important; min-width: 0 !important; min-height: 0 !important; }
    #minimal-dock-overlay .md-bar { display:flex; align-items:center; gap:4px; padding:4px 2px; box-sizing:border-box; height:${BAR}px; background:var(--material-tabbar); border-bottom:var(--tab-border); pointer-events:auto; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; -moz-window-dragging:drag; }
    #minimal-dock-overlay .md-tab { appearance:none; border:0; min-width:58px; max-width:200px; flex:1 1 150px; height:28px; padding-inline-start:6px; padding-inline-end:22px; overflow:hidden; white-space:nowrap; background:transparent; cursor:pointer; font:inherit; }
    #minimal-dock-overlay .md-tab.selected { background:var(--material-button); }
    #minimal-dock-overlay .md-tab .md-tab-icon { flex:0 0 16px; width:16px; height:16px; }
    #minimal-dock-overlay .md-tab .md-tab-title { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:start; margin-inline-start:4px; }
    #minimal-dock-overlay .md-tab .md-tab-close { display:flex !important; position:absolute; inset-inline-end:6px; width:16px; height:16px; align-items:center; justify-content:center; border-radius:3px; cursor:pointer; }
    #minimal-dock-overlay .md-tab .md-tab-close:hover { background:var(--fill-quinary); }
    #minimal-dock-overlay .md-handle { position:absolute; pointer-events:auto; background:#8885; }
    #minimal-dock-overlay .md-handle:hover { background:#478bd9; }
    #minimal-dock-overlay .md-drop { position:absolute; pointer-events:none; border:2px solid #478bd9; background:#478bd933; box-sizing:border-box; display:none; }
    #minimal-dock-overlay .md-drop[data-mode="merge"] { border-color:var(--accent-blue, #478bd9); background:color-mix(in srgb, var(--accent-blue, #478bd9) 18%, transparent); }
  `;
  doc.documentElement?.appendChild(css);

  function element(tag: string, className?: string): HTMLElement {
    const el = doc.createElementNS(XHTML, tag) as HTMLElement;
    if (className) el.className = className;
    return el;
  }
  function leaves(node: Node | null): Leaf[] {
    if (!node) return [];
    return node.kind === "leaf" ? [node] : [...leaves(node.first), ...leaves(node.second)];
  }
  function findLeaf(id: string): Leaf | undefined {
    return leaves(root).find((leaf) => leaf.id === id || leaf.tabs.includes(id));
  }
  function known(id: string): boolean {
    return tabs._tabs.some((tab) => tab.id === id) && !!doc.getElementById(id);
  }
  function makeLeaf(id: string): Leaf {
    return { kind: "leaf", id: `md-pane-${++serial}`, tabs: [id], active: id };
  }
  function replace(node: Node, target: Leaf, replacement: Node): Node {
    if (node === target) return replacement;
    if (node.kind === "leaf") return node;
    node.first = replace(node.first, target, replacement);
    node.second = replace(node.second, target, replacement);
    return node;
  }
  function prune(node: Node): Node | null {
    if (node.kind === "leaf") return node.tabs.length ? node : null;
    const a = prune(node.first);
    const b = prune(node.second);
    if (!a) return b;
    if (!b) return a;
    node.first = a;
    node.second = b;
    return node;
  }
  function removeFromLayout(id: string): void {
    const leaf = findLeaf(id);
    if (!leaf) return;
    leaf.tabs = leaf.tabs.filter((tab) => tab !== id);
    if (leaf.active === id) leaf.active = leaf.tabs[0] || "";
    if (root) root = prune(root);
  }
  function normalize(): void {
    if (!root) return;
    const live = new Set(tabs._tabs.map((tab) => tab.id));
    for (const leaf of leaves(root)) {
      leaf.tabs = leaf.tabs.filter((id) => live.has(id));
      if (!leaf.tabs.includes(leaf.active)) leaf.active = leaf.tabs[0] || "";
    }
    root = prune(root);
  }
  function split(tabID: string, edge: Edge, targetID?: string): string {
    if (!known(tabID)) throw new Error(`Unknown Zotero tab: ${tabID}`);
    if (!["left", "right", "top", "bottom"].includes(edge)) throw new Error(`Invalid edge: ${edge}`);
    if (!root) {
      const initial = known(tabs.selectedID) ? tabs.selectedID : "zotero-pane";
      root = makeLeaf(initial);
      root.tabs = tabs._tabs.map((tab) => tab.id).filter(known);
      root.active = initial;
    }
    const target = findLeaf(targetID || tabs.selectedID) || leaves(root)[0];
    if (!target) throw new Error("No docking target");
    if (target.tabs.includes(tabID) && target.tabs.length === 1) throw new Error("Cannot split a tab against itself");
    removeFromLayout(tabID);
    const next = makeLeaf(tabID);
    const branch: Branch = {
      kind: "branch",
      axis: edge === "left" || edge === "right" ? "horizontal" : "vertical",
      ratio: 0.5,
      first: edge === "left" || edge === "top" ? next : target,
      second: edge === "left" || edge === "top" ? target : next,
    };
    // removeFromLayout can collapse an empty target. In that case, replace the
    // remaining tree directly instead of inserting a detached leaf twice.
    root = root === target ? branch : replace(root!, target, branch);
    render();
    return next.id;
  }
  function move(tabID: string, targetID: string, beforeID?: string): void {
    if (!known(tabID)) throw new Error(`Unknown Zotero tab: ${tabID}`);
    const target = findLeaf(targetID);
    if (!target) throw new Error(`Unknown docking pane: ${targetID}`);
    if (beforeID !== tabID) {
      if (target.tabs.includes(tabID)) target.tabs.splice(target.tabs.indexOf(tabID), 1);
      else removeFromLayout(tabID);
      const index = beforeID ? target.tabs.indexOf(beforeID) : -1;
      target.tabs.splice(index < 0 ? target.tabs.length : index, 0, tabID);
    }
    if (root?.kind === "leaf") {
      let index = 1;
      for (const id of root.tabs) {
        if (id === "zotero-pane") continue;
        const current = tabs._tabs.findIndex(tab => tab.id === id);
        if (current > index) tabs.move?.(id, index);
        if (current >= 0) index++;
      }
    }
    tabs.select(tabID);
  }
  function preserveStyle(el: Element): void {
    if (!savedStyles.has(el)) savedStyles.set(el, el.getAttribute("style"));
  }
  function restoreStyles(): void {
    for (const [el, value] of savedStyles) {
      if (value === null) el.removeAttribute("style");
      else el.setAttribute("style", value);
    }
    savedStyles.clear();
  }
  function wakeReaders(): void {
    const visible = new Set(leaves(root).map((leaf) => leaf.active));
    for (const reader of win.Zotero?.Reader?._readers || []) {
      if (!reader?.tabID || !reader._iframe) continue;
      try {
        if (visible.has(reader.tabID)) reader._iframe.docShellIsActive = true;
        else reader._updateDocShellActivity?.();
      } catch (_) { /* A closing reader can have a dead browser. */ }
    }
  }
  function positionSplitterShield(): void {
    const deckRect = deck.getBoundingClientRect();
    const stackRect = stack.getBoundingClientRect();
    splitterShield.style.left = `${deckRect.left - stackRect.left}px`;
    splitterShield.style.top = `${deckRect.top - stackRect.top}px`;
    splitterShield.style.width = `${deckRect.width}px`;
    splitterShield.style.height = `${deckRect.height}px`;
  }
  function applySplitterDrag(): void {
    const drag = splitterDrag;
    if (!drag) return;
    if (drag.frame !== null) win.cancelAnimationFrame(drag.frame);
    if (drag.timer !== null) win.clearTimeout(drag.timer);
    drag.frame = null;
    drag.timer = null;
    const ratio = Math.max(drag.lower, Math.min(1 - drag.lower, drag.initial + (drag.latest - drag.start) / drag.total));
    if (ratio === drag.node.ratio) return;
    drag.node.ratio = ratio;
    render();
  }
  function onSplitterMove(event: PointerEvent): void {
    const drag = splitterDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === "mouse" && !(event.buttons & 1)) { endSplitterDrag(); return; }
    event.preventDefault();
    drag.latest = drag.horizontal ? event.clientX : event.clientY;
    if (drag.frame === null && drag.timer === null) {
      drag.frame = win.requestAnimationFrame(applySplitterDrag);
      // Zotero's background test windows can suspend rAF. The timer also
      // keeps a real drag responsive when the window briefly loses visibility.
      drag.timer = win.setTimeout(applySplitterDrag, 16);
    }
  }
  function endSplitterDrag(event?: PointerEvent): void {
    const drag = splitterDrag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    if (event && event.type === "pointerup") {
      drag.latest = drag.horizontal ? event.clientX : event.clientY;
      applySplitterDrag();
    } else {
      if (drag.frame !== null) win.cancelAnimationFrame(drag.frame);
      if (drag.timer !== null) win.clearTimeout(drag.timer);
    }
    splitterDrag = null;
    try { splitterShield.releasePointerCapture(drag.pointerId); } catch (_) { /* Capture may already be released. */ }
    splitterShield.style.display = "none";
  }
  function collapseNativeHeader(): number {
    if (!titleBar || !nativeTabBar || !nativeToolbar) return 0;
    preserveStyle(titleBar);
    preserveStyle(nativeTabBar);
    preserveStyle(nativeToolbar);
    nativeTabBar.style.setProperty("display", "none", "important");
    titleBar.style.setProperty("position", "relative", "important");
    titleBar.style.setProperty("height", "0px", "important");
    titleBar.style.setProperty("min-height", "0px", "important");
    titleBar.style.setProperty("max-height", "0px", "important");
    titleBar.style.setProperty("border", "0", "important");
    titleBar.style.setProperty("overflow", "visible", "important");
    titleBar.style.setProperty("z-index", "40", "important");
    nativeToolbar.style.setProperty("position", "absolute", "important");
    nativeToolbar.style.setProperty("z-index", "41", "important");
    const deckBounds = deck.getBoundingClientRect();
    const titleBounds = titleBar.getBoundingClientRect();
    const width = nativeToolbar.getBoundingClientRect().width;
    nativeToolbar.style.setProperty("left", `${deckBounds.right - titleBounds.left - width}px`, "important");
    nativeToolbar.style.setProperty("top", `${deckBounds.top - titleBounds.top}px`, "important");
    return width;
  }
  function render(): void {
    if (disposed) return;
    normalize();
    if (!root || leaves(root).length < 2) {
      resetVisuals();
      return;
    }
    preserveStyle(deck);
    deck.classList.add("minimal-dock-active");
    const toolbarWidth = collapseNativeHeader();
    if (!nativeTabList?.isConnected) {
      nativeTabList = doc.querySelector("#tab-bar-container .tab-bar-inner-container") as HTMLElement | null;
    }
    if (nativeTabList) {
      preserveStyle(nativeTabList);
      nativeTabList.dataset.minimalDockHidden = "true";
      nativeTabList.style.setProperty("display", "none", "important");
    }
    const deckRect = deck.getBoundingClientRect();
    const stackRect = stack.getBoundingClientRect();
    overlay.style.left = `${deckRect.left - stackRect.left}px`;
    overlay.style.top = `${deckRect.top - stackRect.top}px`;
    overlay.style.width = `${deckRect.width}px`;
    overlay.style.height = `${deckRect.height}px`;
    if (splitterDrag) positionSplitterShield();
    handles.replaceChildren();
    const paneIDs = new Set<string>();
    const shown = new Set<string>();
    const layout = (node: Node, x: number, y: number, w: number, h: number): void => {
      if (node.kind === "branch") {
        const horizontal = node.axis === "horizontal";
        const total = horizontal ? w : h;
        const lower = Math.min(0.5, (horizontal ? 240 : 180) / Math.max(1, total));
        const [first, second] = splitBounds(node.axis, node.ratio, { x, y, w, h });
        const firstSize = horizontal ? first.w : first.h;
        layout(node.first, first.x, first.y, first.w, first.h);
        layout(node.second, second.x, second.y, second.w, second.h);
        const handle = element("div", "md-handle");
        handle.style.cssText = horizontal
          ? `left:${x + firstSize - HANDLE / 2}px;top:${y}px;width:${HANDLE}px;height:${h}px;cursor:col-resize;`
          : `left:${x}px;top:${y + firstSize - HANDLE / 2}px;width:${w}px;height:${HANDLE}px;cursor:row-resize;`;
        handle.addEventListener("pointerdown", (event: PointerEvent) => {
          if (event.button !== 0 || !total || lower === 0.5) return;
          event.preventDefault();
          if (splitterDrag) endSplitterDrag();
          const start = horizontal ? event.clientX : event.clientY;
          splitterDrag = { node, pointerId: event.pointerId, start, latest: start, initial: firstSize / total, total, lower, horizontal, frame: null, timer: null };
          positionSplitterShield();
          splitterShield.style.cursor = horizontal ? "col-resize" : "row-resize";
          splitterShield.style.display = "block";
          try { splitterShield.setPointerCapture(event.pointerId); } catch (_) { /* Window listeners still finish the drag. */ }
        });
        handles.appendChild(handle);
        return;
      }
      const leaf = node;
      paneIDs.add(leaf.id);
      shown.add(leaf.active);
      const signature = JSON.stringify([leaf.active, leaf.tabs.map(id => {
        const tab = tabs._tabs.find(item => item.id === id);
        return [id, tab?.title, tab?.type];
      })]);
      const previous = bars.get(leaf.id);
      const bar = previous?.signature === signature ? previous.element : buildTabBar(leaf);
      if (bar !== previous?.element) {
        if (previous) {
          const offset = previous.element.scrollLeft;
          previous.element.replaceWith(bar);
          bar.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;`;
          bar.scrollLeft = offset;
        }
        else overlay.appendChild(bar);
        bars.set(leaf.id, { element: bar, signature });
      }
      bar.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;`;
      if (toolbarWidth && y === 0 && x + w === deckRect.width) {
        bar.style.paddingRight = `${toolbarWidth + 6}px`;
      }
      const pane = doc.getElementById(leaf.active) as HTMLElement | null;
      if (pane?.parentElement === deck) {
        preserveStyle(pane);
        pane.style.setProperty("left", `${x}px`, "important");
        pane.style.setProperty("top", `${y + BAR}px`, "important");
        pane.style.setProperty("width", `${w}px`, "important");
        pane.style.setProperty("height", `${Math.max(0, h - BAR)}px`, "important");
        pane.style.setProperty("visibility", "visible", "important");
        pane.style.setProperty("pointer-events", "auto", "important");
        pane.style.setProperty("z-index", "1", "important");
      }
    };
    function buildTabBar(leaf: Leaf): HTMLElement {
      const bar = element("div", "md-bar");
      bar.dataset.pane = leaf.id;
      bar.addEventListener("wheel", (event: WheelEvent) => {
        if (event.deltaX || event.ctrlKey || bar.scrollWidth <= bar.clientWidth) return;
        event.preventDefault();
        bar.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      }, { passive: false });
      for (const id of leaf.tabs) {
        const tab = tabs._tabs.find((item) => item.id === id);
        const button = element("button", "md-tab tab") as HTMLButtonElement;
        const title = tab?.title || (id === "zotero-pane" ? "Library" : id);
        button.title = title;
        button.dataset.active = String(id === leaf.active);
        button.dataset.tabId = id;
        if (id === leaf.active) button.classList.add("selected");
        const nativeIcon = doc.querySelector(`#tab-bar-container .tab[data-id="${CSS.escape(id)}"] .tab-icon`);
        const icon = nativeIcon?.cloneNode(true) as HTMLElement | undefined || element("span", "tab-icon");
        icon.classList.add("md-tab-icon");
        button.appendChild(icon);
        const label = element("span", "md-tab-title tab-name");
        label.textContent = title;
        button.appendChild(label);
        button.draggable = true;
        button.addEventListener("click", () => tabs.select(id));
        button.addEventListener("dragend", clearDragSurface);
        button.addEventListener("dragstart", (event: DragEvent) => {
          dragID = id;
          event.dataTransfer?.setData(TAB_TYPE, id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          win.setTimeout(showDragSurface, 0);
        });
        bar.appendChild(button);
        if (id !== "zotero-pane") {
          const close = element("span", "md-tab-close tab-close");
          const nativeClose = doc.querySelector(`#tab-bar-container .tab[data-id="${CSS.escape(id)}"] .tab-close .icon`);
          if (nativeClose) close.appendChild(nativeClose.cloneNode(true));
          else close.textContent = "×";
          close.title = "Close tab";
          close.setAttribute("role", "button");
          close.style.cssText = "margin-left:5px;padding:0 3px;cursor:pointer;";
          close.addEventListener("click", (event) => {
            event.stopPropagation();
            tabs.close(id);
          });
          button.appendChild(close);
        }
      }
      return bar;
    }
    layout(root, 0, 0, deckRect.width, deckRect.height);
    for (const [id, entry] of bars) {
      if (paneIDs.has(id)) continue;
      entry.element.remove();
      bars.delete(id);
    }
    if (dragID) showDragSurface();
    for (const child of Array.from(deck.children)) {
      if (!shown.has(child.id)) {
        preserveStyle(child);
        (child as HTMLElement).style.setProperty("visibility", "hidden", "important");
        (child as HTMLElement).style.setProperty("pointer-events", "none", "important");
        (child as HTMLElement).style.setProperty("z-index", "0", "important");
      }
    }
    wakeReaders();
  }
  function resetVisuals(): void {
    endSplitterDrag();
    deck.classList.remove("minimal-dock-active");
    nativeTabList?.removeAttribute("data-minimal-dock-hidden");
    restoreStyles();
    handles.replaceChildren();
    for (const { element } of bars.values()) element.remove();
    bars.clear();
    clearDragSurface();
    wakeReaders();
  }
  function reset(): void { root = null; render(); }
  function dragDestination(event: DragEvent, id: string): { leaf?: Leaf; edge: Edge | null; bar: boolean; rect: Rect } | null {
    const bounds = deck.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return null;
    let node = root;
    const workspace = { x: 0, y: 0, w: bounds.width, h: bounds.height };
    let rect = workspace;
    while (node?.kind === "branch") {
      const [first, second] = splitBounds(node.axis, node.ratio, rect);
      const inFirst = node.axis === "horizontal" ? x < second.x : y < second.y;
      rect = inFirst ? first : second;
      node = inFirst ? node.first : node.second;
    }
    const leaf = node ?? undefined;
    const bar = !!leaf && y >= rect.y && y < rect.y + BAR;
    if (bar) return { leaf, edge: null, bar: true, rect };
    const rx = (x - rect.x) / rect.w;
    const contentTop = rect.y + (leaf ? BAR : 0);
    const contentHeight = Math.max(1, rect.h - (leaf ? BAR : 0));
    const ry = (y - contentTop) / contentHeight;
    const margin = Math.min(rx, 1 - rx, ry, 1 - ry);
    const edge: Edge | null = margin >= 0.24 ? null
      : margin === rx ? "left" : margin === 1 - rx ? "right" : margin === ry ? "top" : "bottom";
    if (edge) {
      if (leaf?.tabs.length === 1 && leaf.tabs[0] === id) return null;
      if (!leaf && tabs._tabs.filter(tab => known(tab.id)).length < 2) return null;
      const source = findLeaf(id);
      if (root && leaf && source?.tabs.length === 1) {
        const remaining = withoutLeaf(root, source);
        if (remaining) rect = boundsOf(remaining, leaf, workspace) ?? rect;
      }
    } else if (!leaf || leaf.tabs.includes(id)) return null;
    return { leaf, edge, bar: false, rect };
  }
  function showDragSurface(): void {
    if (!dragID || disposed) return;
    const bounds = deck.getBoundingClientRect();
    const stackBounds = stack.getBoundingClientRect();
    overlay.style.left = `${bounds.left - stackBounds.left}px`;
    overlay.style.top = `${bounds.top - stackBounds.top}px`;
    overlay.style.width = `${bounds.width}px`;
    overlay.style.height = `${bounds.height}px`;
    if (overlay.querySelector(".md-drag-surface")) return;
    const surface = element("div", "md-drag-surface");
    surface.style.cssText = "position:absolute;inset:0;z-index:100;pointer-events:auto;background:transparent;";
    const preview = element("div", "md-drop");
    surface.appendChild(preview);
    surface.addEventListener("dragover", (event: DragEvent) => {
      if (!dragID) return;
      event.preventDefault();
      const destination = dragDestination(event, dragID);
      if (event.dataTransfer) event.dataTransfer.dropEffect = destination ? "move" : "none";
      if (!destination) { preview.style.display = "none"; return; }
      const { edge, bar, rect } = destination;
      let { x, y, w, h } = rect;
      if (bar) h = BAR;
      else if (edge) {
        const sides = splitBounds(edge === "left" || edge === "right" ? "horizontal" : "vertical", 0.5, rect);
        ({ x, y, w, h } = sides[edge === "left" || edge === "top" ? 0 : 1]);
      }
      preview.dataset.mode = bar ? "merge" : edge ? "split" : "move";
      preview.style.cssText = `display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
    });
    surface.addEventListener("dragleave", () => { preview.style.display = "none"; });
    surface.addEventListener("drop", onDeckDrop);
    overlay.appendChild(surface);
  }
  function clearDragSurface(): void {
    dragID = null;
    overlay.querySelector(".md-drag-surface")?.remove();
  }
  function syncNativeSelection(): void {
    if (disposed || !root) return;
    const selected = tabs.selectedID;
    const leaf = findLeaf(selected);
    if (leaf) leaf.active = selected;
    else if (known(selected)) {
      const destination = findLeaf(lastSelectedID) || leaves(root)[0];
      if (destination && !destination.tabs.includes(selected)) destination.tabs.push(selected);
      if (destination) destination.active = selected;
    }
    lastSelectedID = selected;
    render();
    win.setTimeout(wakeReaders, 0);
  }
  function onDeckInteraction(event: Event): void {
    if (!root) return;
    const pane = (event.target as Element | null)?.closest?.("tab-content");
    if (!pane || pane.id === tabs.selectedID) return;
    const leaf = findLeaf(pane.id);
    if (leaf?.active === pane.id) tabs.select(pane.id);
  }
  function onEscape(event: KeyboardEvent): void {
    if (event.key === "Escape" && dragID) clearDragSurface();
  }
  function beforeTabAt(leaf: Leaf, clientX: number): string | undefined {
    const bar = bars.get(leaf.id)?.element;
    if (!bar) return undefined;
    const rtl = win.getComputedStyle(bar).direction === "rtl";
    for (const button of bar.querySelectorAll<HTMLElement>(".md-tab")) {
      const rect = button.getBoundingClientRect();
      const middle = rect.left + rect.width / 2;
      if (rtl ? clientX > middle : clientX < middle) return button.dataset.tabId;
    }
    return undefined;
  }
  function onNativeDragStart(event: DragEvent): void {
    const tab = (event.target as Element | null)?.closest?.("#tab-bar-container .tab[data-id]");
    const id = tab?.getAttribute("data-id");
    if (!id) return;
    if (id === "zotero-pane") event.stopPropagation();
    dragID = id;
    event.dataTransfer?.setData(TAB_TYPE, id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    win.setTimeout(showDragSurface, 0);
  }
  function onNativeDragEnd(): void { clearDragSurface(); }
  function onDeckDragOver(event: DragEvent): void {
    if (!dragID || !known(dragID)) return;
    event.preventDefault();
    showDragSurface();
  }
  function onDeckDrop(event: DragEvent): void {
    const id = dragID;
    if (!id || !known(id)) return;
    const destination = dragDestination(event, id);
    event.preventDefault();
    event.stopPropagation();
    clearDragSurface();
    if (!destination) return;
    const { leaf, edge, bar } = destination;
    if (edge) split(id, edge, leaf?.id);
    else if (leaf) move(id, leaf.id, bar ? beforeTabAt(leaf, event.clientX) : undefined);
  }

  tabs.select = function (this: TabsHost, ...args: any[]) {
    const destination = findLeaf(tabs.selectedID) || leaves(root)[0];
    const result = original.select.apply(this, args);
    const leaf = findLeaf(args[0]);
    if (leaf) leaf.active = args[0];
    else if (root && known(args[0])) {
      if (destination) { destination.tabs.push(args[0]); destination.active = args[0]; }
    }
    render();
    lastSelectedID = tabs.selectedID;
    win.setTimeout(wakeReaders, 0);
    return result;
  };
  tabs.add = function (this: TabsHost, ...args: any[]) {
    const destination = findLeaf(tabs.selectedID) || leaves(root)[0];
    const result = original.add.apply(this, args);
    if (root && destination && result?.id && !findLeaf(result.id)) {
      destination.tabs.push(result.id);
      render();
    }
    return result;
  };
  tabs.close = function (this: TabsHost, ...args: any[]) {
    const ids = args[0] === undefined ? [tabs.selectedID] : Array.isArray(args[0]) ? args[0] : [args[0]];
    const result = original.close.apply(this, args);
    for (const id of ids) removeFromLayout(id);
    render();
    win.setTimeout(render, 0);
    return result;
  };
  tabs.canUnload = function (this: TabsHost, id: string) {
    if (leaves(root).some((leaf) => leaf.active === id)) return false;
    return original.canUnload.call(this, id);
  };
  const observer = new win.MutationObserver(() => {
    if (mutating || disposed || !root) return;
    mutating = true;
    win.setTimeout(() => { mutating = false; render(); }, 0);
  });
  observer.observe(deck, { childList: true });
  const resize = new win.ResizeObserver(() => render());
  resize.observe(deck);
  win.addEventListener("pointermove", onSplitterMove, true);
  win.addEventListener("pointerup", endSplitterDrag, true);
  win.addEventListener("pointercancel", endSplitterDrag, true);
  splitterShield.addEventListener("lostpointercapture", endSplitterDrag);
  const notifierID = win.Zotero.Notifier.registerObserver({
    notify(event: string, type: string) {
      if (type === "tab" && (event === "select" || event === "add" || event === "close" || event === "modify")) {
        win.setTimeout(syncNativeSelection, 0);
      }
    },
  }, ["tab"], "minimal-dock");
  doc.addEventListener("dragstart", onNativeDragStart, true);
  doc.addEventListener("dragend", onNativeDragEnd, true);
  doc.addEventListener("keydown", onEscape, true);
  deck.addEventListener("pointerdown", onDeckInteraction, true);
  deck.addEventListener("focusin", onDeckInteraction, true);
  deck.addEventListener("dragover", onDeckDragOver, true);
  deck.addEventListener("drop", onDeckDrop, true);

  const api = {
    split,
    move,
    reset,
    getState: () => ({ active: !!root && leaves(root).length > 1, layout: root ? JSON.parse(JSON.stringify(root)) : null }),
  };
  if (win.Zotero?.MinimalDock?.data) win.Zotero.MinimalDock.data.dock = api;
  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    resize.disconnect();
    endSplitterDrag();
    win.removeEventListener("pointermove", onSplitterMove, true);
    win.removeEventListener("pointerup", endSplitterDrag, true);
    win.removeEventListener("pointercancel", endSplitterDrag, true);
    splitterShield.removeEventListener("lostpointercapture", endSplitterDrag);
    win.Zotero.Notifier.unregisterObserver(notifierID);
    doc.removeEventListener("dragstart", onNativeDragStart, true);
    doc.removeEventListener("dragend", onNativeDragEnd, true);
    doc.removeEventListener("keydown", onEscape, true);
    deck.removeEventListener("pointerdown", onDeckInteraction, true);
    deck.removeEventListener("focusin", onDeckInteraction, true);
    deck.removeEventListener("dragover", onDeckDragOver, true);
    deck.removeEventListener("drop", onDeckDrop, true);
    root = null;
    resetVisuals();
    tabs.select = original.select;
    tabs.add = original.add;
    tabs.close = original.close;
    tabs.canUnload = original.canUnload;
    overlay.remove();
    splitterShield.remove();
    css.remove();
    if (win.Zotero?.MinimalDock?.data) {
      if (previousDock === undefined) delete win.Zotero.MinimalDock.data.dock;
      else win.Zotero.MinimalDock.data.dock = previousDock;
    }
  };
}
