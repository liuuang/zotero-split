/** In-window docking for Zotero's existing tab-content nodes. */
type Edge = "left" | "right" | "top" | "bottom";
type Leaf = { kind: "leaf"; id: string; tabs: string[]; active: string };
type Branch = { kind: "branch"; axis: "horizontal" | "vertical"; ratio: number; first: Node; second: Node };
type Node = Leaf | Branch;

interface TabsHost {
  _tabs: Array<{ id: string; title: string; type: string }>;
  selectedID: string;
  select: (...args: any[]) => any;
  add: (...args: any[]) => any;
  close: (...args: any[]) => any;
  canUnload: (id: string) => boolean;
}

const XHTML = "http://www.w3.org/1999/xhtml";
const BAR = 36;
const HANDLE = 6;

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
  const leafRects = new Map<string, { x: number; y: number; w: number; h: number }>();
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
  stack.appendChild(overlay);
  const css = doc.createElementNS(XHTML, "style") as HTMLStyleElement;
  css.textContent = `
    #tabs-deck.minimal-dock-active { display: block !important; position: relative !important; min-width: 0 !important; overflow: hidden !important; }
    #tabs-deck.minimal-dock-active > tab-content { -moz-subtree-hidden-only-visually: 0 !important; position: absolute !important; min-width: 0 !important; min-height: 0 !important; }
    #minimal-dock-overlay .md-bar { display:flex; align-items:center; gap:4px; padding:4px 2px; box-sizing:border-box; height:${BAR}px; background:var(--material-tabbar); border-bottom:var(--tab-border); pointer-events:auto; overflow:hidden; -moz-window-dragging:drag; }
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
    if (target.tabs.includes(tabID)) {
      target.tabs = target.tabs.filter((id) => id !== tabID);
      const index = beforeID ? target.tabs.indexOf(beforeID) : -1;
      if (index < 0) target.tabs.push(tabID);
      else target.tabs.splice(index, 0, tabID);
      target.active = tabID;
      tabs.select(tabID);
      render();
      return;
    }
    removeFromLayout(tabID);
    const index = beforeID ? target.tabs.indexOf(beforeID) : -1;
    if (index < 0) target.tabs.push(tabID);
    else target.tabs.splice(index, 0, tabID);
    target.active = tabID;
    tabs.select(tabID);
    render();
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
    overlay.replaceChildren();
    leafRects.clear();
    const shown = new Set<string>();
    const layout = (node: Node, x: number, y: number, w: number, h: number): void => {
      if (node.kind === "branch") {
        const horizontal = node.axis === "horizontal";
        const total = horizontal ? w : h;
        const minimum = horizontal ? 240 : 180;
        const lower = total >= minimum * 2 ? minimum / total : 0.5;
        node.ratio = Math.max(lower, Math.min(1 - lower, node.ratio));
        const firstSize = Math.round(total * node.ratio);
        if (horizontal) {
          layout(node.first, x, y, firstSize, h);
          layout(node.second, x + firstSize, y, w - firstSize, h);
        } else {
          layout(node.first, x, y, w, firstSize);
          layout(node.second, x, y + firstSize, w, h - firstSize);
        }
        const handle = element("div", "md-handle");
        handle.style.cssText = horizontal
          ? `left:${x + firstSize - HANDLE / 2}px;top:${y}px;width:${HANDLE}px;height:${h}px;cursor:col-resize;`
          : `left:${x}px;top:${y + firstSize - HANDLE / 2}px;width:${w}px;height:${HANDLE}px;cursor:row-resize;`;
        handle.addEventListener("pointerdown", (event: PointerEvent) => {
          event.preventDefault();
          handle.setPointerCapture(event.pointerId);
          const start = horizontal ? event.clientX : event.clientY;
          const initial = node.ratio;
          const onMove = (moveEvent: PointerEvent) => {
            node.ratio = Math.max(lower, Math.min(1 - lower, initial + ((horizontal ? moveEvent.clientX : moveEvent.clientY) - start) / total));
            render();
          };
          const onUp = () => {
            win.removeEventListener("pointermove", onMove, true);
            win.removeEventListener("pointerup", onUp, true);
          };
          win.addEventListener("pointermove", onMove, true);
          win.addEventListener("pointerup", onUp, true);
        });
        overlay.appendChild(handle);
        return;
      }
      const leaf = node;
      leafRects.set(leaf.id, { x, y, w, h });
      shown.add(leaf.active);
      const bar = element("div", "md-bar");
      bar.style.cssText += `position:absolute;left:${x}px;top:${y}px;width:${w}px;`;
      bar.dataset.pane = leaf.id;
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
        button.addEventListener("click", () => { leaf.active = id; tabs.select(id); render(); });
        button.addEventListener("dragstart", (event: DragEvent) => {
          dragID = id;
          event.dataTransfer?.setData("application/x-minimal-dock-tab", id);
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
      overlay.appendChild(bar);
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
    layout(root, 0, 0, deckRect.width, deckRect.height);
    if (toolbarWidth) {
      const topY = Math.min(...Array.from(leafRects.values()).map((rect) => rect.y));
      const rightmost = Array.from(leafRects.entries())
        .filter(([, rect]) => rect.y === topY)
        .sort((a, b) => (b[1].x + b[1].w) - (a[1].x + a[1].w))[0];
      const bar = rightmost && (Array.from(overlay.querySelectorAll(".md-bar")) as HTMLElement[])
        .find((item) => item.dataset.pane === rightmost[0]);
      if (bar) bar.style.paddingInlineEnd = `${toolbarWidth + 6}px`;
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
    deck.classList.remove("minimal-dock-active");
    nativeTabList?.removeAttribute("data-minimal-dock-hidden");
    restoreStyles();
    overlay.replaceChildren();
    leafRects.clear();
    wakeReaders();
  }
  function reset(): void { root = null; render(); }
  function liveLeafRects(width: number, height: number): Map<string, { x: number; y: number; w: number; h: number }> {
    const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
    const place = (node: Node, x: number, y: number, w: number, h: number): void => {
      if (node.kind === "leaf") { rects.set(node.id, { x, y, w, h }); return; }
      const horizontal = node.axis === "horizontal";
      const first = Math.round((horizontal ? w : h) * node.ratio);
      if (horizontal) {
        place(node.first, x, y, first, h);
        place(node.second, x + first, y, w - first, h);
      } else {
        place(node.first, x, y, w, first);
        place(node.second, x, y + first, w, h - first);
      }
    };
    if (root) place(root, 0, 0, width, height);
    return rects;
  }
  function dragDestination(event: DragEvent): { leaf: Leaf | undefined; edge: Edge | null; bar: boolean; rect: { x: number; y: number; w: number; h: number } } {
    const bounds = deck.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const liveRects = liveLeafRects(bounds.width, bounds.height);
    const leaf = leaves(root).find((candidate) => {
      const r = liveRects.get(candidate.id);
      return r && x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
    }) || findLeaf(tabs.selectedID) || leaves(root)[0];
    const rect = leaf ? liveRects.get(leaf.id) || { x: 0, y: 0, w: bounds.width, h: bounds.height }
      : { x: 0, y: 0, w: bounds.width, h: bounds.height };
    const bar = !!leaf && y >= rect.y && y < rect.y + BAR;
    if (bar) return { leaf, edge: null, bar: true, rect };
    const rx = (x - rect.x) / rect.w;
    const contentTop = rect.y + (leaf ? BAR : 0);
    const contentHeight = Math.max(1, rect.h - (leaf ? BAR : 0));
    const ry = (y - contentTop) / contentHeight;
    const margin = Math.min(rx, 1 - rx, ry, 1 - ry);
    const edge: Edge | null = margin >= 0.24 ? null
      : margin === rx ? "left" : margin === 1 - rx ? "right" : margin === ry ? "top" : "bottom";
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
    preview.style.display = "block";
    surface.appendChild(preview);
    surface.addEventListener("dragover", (event: DragEvent) => {
      if (!dragID) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const { edge, bar, rect } = dragDestination(event);
      let { x, y, w, h } = rect;
      if (bar) h = BAR;
      else if (edge === "left") w /= 2;
      else if (edge === "right") { x += w / 2; w /= 2; }
      else if (edge === "top") h /= 2;
      else if (edge === "bottom") { y += h / 2; h /= 2; }
      preview.dataset.mode = bar ? "merge" : edge ? "split" : "move";
      preview.style.cssText = `display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
    });
    surface.addEventListener("drop", (event: DragEvent) => {
      const id = event.dataTransfer?.getData("application/x-minimal-dock-tab") || dragID;
      if (!id || !known(id)) return;
      event.preventDefault();
      event.stopPropagation();
      const { leaf, edge } = dragDestination(event);
      dragID = null;
      surface.remove();
      if (edge) split(id, edge, leaf?.id);
      else if (leaf) move(id, leaf.id, beforeTabAt(leaf, event.clientX));
    });
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
    return leaf.tabs.find((candidate) => {
      const button = (Array.from(overlay.querySelectorAll(".md-tab")) as HTMLElement[])
        .find((node) => node.dataset.tabId === candidate);
      if (!button) return false;
      const rect = button.getBoundingClientRect();
      return clientX < rect.left + rect.width / 2;
    });
  }
  function onNativeDragStart(event: DragEvent): void {
    const tab = (event.target as Element | null)?.closest?.("#tab-bar-container .tab[data-id]");
    const id = tab?.getAttribute("data-id");
    if (!id) return;
    if (id === "zotero-pane") event.stopPropagation();
    dragID = id;
    event.dataTransfer?.setData("application/x-minimal-dock-tab", id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    win.setTimeout(showDragSurface, 0);
  }
  function onNativeDragEnd(): void { clearDragSurface(); }
  function onDeckDragOver(event: DragEvent): void {
    const id = event.dataTransfer?.getData("application/x-minimal-dock-tab") || dragID;
    if (!id || !known(id)) return;
    event.preventDefault();
  }
  function onDeckDrop(event: DragEvent): void {
    const id = event.dataTransfer?.getData("application/x-minimal-dock-tab") || dragID;
    if (!id || !known(id)) return;
    const { leaf, edge } = dragDestination(event);
    event.preventDefault();
    event.stopPropagation();
    clearDragSurface();
    if (edge) split(id, edge, leaf?.id);
    else if (leaf) move(id, leaf.id, beforeTabAt(leaf, event.clientX));
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
    const result = original.add.apply(this, args);
    if (root) render();
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
  const notifierID = win.Zotero.Notifier.registerObserver({
    notify(event: string, type: string) {
      if (type === "tab" && (event === "select" || event === "add" || event === "close")) {
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
    css.remove();
    if (win.Zotero?.MinimalDock?.data) {
      if (previousDock === undefined) delete win.Zotero.MinimalDock.data.dock;
      else win.Zotero.MinimalDock.data.dock = previousDock;
    }
  };
}
