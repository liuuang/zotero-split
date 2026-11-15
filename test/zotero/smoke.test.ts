import { assert } from "chai";
import { rgXpiPath } from "./rg-path.generated";

describe("Zotero Split smoke", function () {
  this.timeout(90000);

  const window = Zotero.getMainWindow() as any;
  const tabs = window.Zotero_Tabs;
  const addon = (Zotero as any).MinimalDock;
  const ids = ["minimal-dock-smoke-a", "minimal-dock-smoke-b"];
  const containers: Element[] = [];
  let pdfAttachmentID = 0;

  after(function () {
    addon?.data.dock?.reset();
    for (const id of ids) {
      if (tabs._tabs.some((tab: any) => tab.id === id)) tabs.close(id);
    }
  });

  it("initializes without replacing the Zotero library", async function () {
    assert.isTrue(addon.data.initialized);
    assert.isFunction(addon.data.dock?.split);
    const item = new Zotero.Item("journalArticle");
    item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField("title", "Minimal Dock smoke item");
    await item.saveTx();
    assert.equal(Zotero.Items.get(item.id)?.getField("title"), "Minimal Dock smoke item");
  });

  it("shows library and two custom native tabs in three columns", async function () {
    const nativeStrip = window.document.querySelector("#tab-bar-container .tab[data-id]");
    const nativeList = window.document.querySelector("#tab-bar-container .tab-bar-inner-container");
    const globalBar = window.document.getElementById("zotero-tabs-toolbar");
    const titleBar = window.document.getElementById("zotero-title-bar");
    assert.isNotNull(nativeStrip);
    assert.isNotNull(nativeList);
    assert.isNotNull(globalBar);
    assert.isNotNull(titleBar);
    const titleParent = titleBar.parentElement;
    const titleStyle = titleBar.getAttribute("style");
    const titleHeight = titleBar.getBoundingClientRect().height;
    const toolbarParent = globalBar.parentElement;
    const toolbarStyle = globalBar.getAttribute("style");
    const visible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        style.opacity !== "0" && rect.width > 0 && rect.height > 0;
    };
    const listStyle = window.getComputedStyle(nativeList);
    assert.notEqual(listStyle.display, "none", "native strip starts displayed");
    for (const [index, id] of ids.entries()) {
      const { container } = tabs.add({
        id,
        type: "minimal-dock-smoke",
        title: `Dock test ${index + 1}`,
        data: {},
        select: true,
      });
      const marker = window.document.createElement("div");
      marker.textContent = `Dock content ${index + 1}`;
      container.appendChild(marker);
      containers.push(container);
    }
    const nativeListStyle = nativeList.getAttribute("style");

    addon.data.dock.split(ids[0], "right", "zotero-pane");
    addon.data.dock.split(ids[1], "right", ids[0]);
    await Zotero.Promise.delay(150);
    assert.equal(nativeList.getAttribute("data-minimal-dock-hidden"), "true");
    assert.isFalse(visible(nativeList), "global duplicate tab strip is hidden while split");
    assert.isTrue(visible(globalBar), "global tab bar and controls remain visible");
    assert.isAtMost(titleBar.getBoundingClientRect().height, 1, "old title row is collapsed");
    assert.strictEqual(globalBar.parentElement, toolbarParent, "toolbar keeps its original parent");
    const rightBar = window.document.querySelector(
      `#minimal-dock-overlay .md-tab[data-tab-id="${ids[1]}"]`,
    )?.closest(".md-bar");
    assert.isNotNull(rightBar);
    const toolbarRect = globalBar.getBoundingClientRect();
    const rightBarRect = rightBar.getBoundingClientRect();
    const rightTabRect = rightBar.querySelector(".md-tab")?.getBoundingClientRect();
    assert.isAtLeast(toolbarRect.left, rightTabRect.right - 2, "toolbar does not cover pane tab");
    assert.isAtMost(toolbarRect.right, rightBarRect.right + 2);
    assert.isAtLeast(toolbarRect.top, rightBarRect.top - 2);
    assert.isAtMost(toolbarRect.bottom, rightBarRect.bottom + 2);
    const hit = window.document.elementFromPoint(
      toolbarRect.left + toolbarRect.width / 2,
      toolbarRect.top + toolbarRect.height / 2,
    );
    assert.isTrue(hit === globalBar || globalBar.contains(hit), "toolbar accepts pointer input");
    const windowButtons = Array.from(window.document.querySelectorAll(".titlebar-buttonbox .titlebar-button"));
    assert.isAbove(windowButtons.length, 0);
    assert.isTrue(windowButtons.some(visible), "window buttons remain visible");
    for (const [index, id] of ids.entries()) {
      const paneTab = window.document.querySelector(`#minimal-dock-overlay .md-tab[data-tab-id="${id}"]`);
      assert.isNotNull(paneTab);
      assert.include(paneTab.querySelector(".md-tab-title")?.textContent, `Dock test ${index + 1}`);
      assert.isNotNull(paneTab.querySelector(".md-tab-icon"));
      assert.isNotNull(paneTab.querySelector(".md-tab-close"));
    }
    const panels = [window.document.getElementById("zotero-pane"), ...containers];
    const rects = panels.map((panel) => panel.getBoundingClientRect());
    for (const rect of rects) {
      assert.isAbove(rect.width, 0);
      assert.isAbove(rect.height, 0);
    }
    for (const panel of panels) {
      const style = window.getComputedStyle(panel);
      assert.notEqual(style.visibility, "hidden");
      assert.notEqual(style.display, "none");
      assert.equal(panel.parentElement?.id, "tabs-deck");
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const overlap = Math.max(0, Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left));
        assert.isBelow(overlap, 2, `columns ${i} and ${j} overlap`);
      }
    }
    addon.data.dock.reset();
    assert.strictEqual(titleBar.parentElement, titleParent);
    assert.equal(titleBar.getAttribute("style"), titleStyle);
    assert.closeTo(titleBar.getBoundingClientRect().height, titleHeight, 1);
    assert.strictEqual(globalBar.parentElement, toolbarParent);
    assert.equal(globalBar.getAttribute("style"), toolbarStyle);
    assert.isNull(nativeList.getAttribute("data-minimal-dock-hidden"));
    assert.equal(nativeList.getAttribute("style"), nativeListStyle);
    assert.notEqual(window.getComputedStyle(nativeList).display, "none", "reset restores the native strip");
    addon.data.dock.split(ids[0], "right", "zotero-pane");
    addon.hooks.onMainWindowUnload(window);
    assert.strictEqual(titleBar.parentElement, titleParent);
    assert.equal(titleBar.getAttribute("style"), titleStyle);
    assert.closeTo(titleBar.getBoundingClientRect().height, titleHeight, 1);
    assert.strictEqual(globalBar.parentElement, toolbarParent);
    assert.equal(globalBar.getAttribute("style"), toolbarStyle);
    assert.isNull(nativeList.getAttribute("data-minimal-dock-hidden"));
    assert.equal(nativeList.getAttribute("style"), nativeListStyle);
    assert.notEqual(window.getComputedStyle(nativeList).display, "none", "unload restores the native strip");
    for (const panel of panels) assert.equal(panel.parentElement?.id, "tabs-deck");
    addon.hooks.onMainWindowLoad(window);
  });

  it("tracks nested divider drags without jumps or leaked listeners", async function () {
    const dock = addon.data.dock;
    dock.split(ids[0], "right", "zotero-pane");
    dock.split(ids[1], "bottom", ids[0]);
    const state = () => dock.getState().layout;
    const event = (type: string, x: number, y: number) => new window.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 17, pointerType: "mouse", isPrimary: true,
      clientX: x, clientY: y,
    });
    const drag = async (axis: "horizontal" | "vertical", offsets: number[], end: string) => {
      const handles = Array.from(window.document.querySelectorAll("#minimal-dock-overlay .md-handle")) as HTMLElement[];
      const handle = handles.find((h) => {
        const r = h.getBoundingClientRect();
        return axis === "horizontal" ? r.height > r.width : r.width > r.height;
      });
      assert.isNotNull(handle);
      const rect = handle.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const ratio = () => axis === "horizontal" ? state().ratio : state().second.ratio;
      const values = [ratio()];
      handle.dispatchEvent(event("pointerdown", x, y));
      const shield = window.document.getElementById("minimal-dock-overlay")?.nextElementSibling as HTMLElement;
      assert.isNotNull(shield);
      assert.notEqual(window.getComputedStyle(shield).display, "none");
      for (const offset of offsets) {
        shield.dispatchEvent(event("pointermove", x + (axis === "horizontal" ? offset : 0), y + (axis === "vertical" ? offset : 0)));
        await Zotero.Promise.delay(30);
        values.push(ratio());
      }
      (end === "blur" ? window : shield).dispatchEvent(end === "blur" ? new window.Event("blur") : event(end, x + (axis === "horizontal" ? offsets.at(-1)! : 0), y + (axis === "vertical" ? offsets.at(-1)! : 0)));
      assert.equal(window.getComputedStyle(shield).display, "none");
      return { values, x, y, ratio };
    };
    try {
      const horizontal = await drag("horizontal", [30, 60, 90, 90, 30], "pointerup");
      assert.isAbove(horizontal.values[1], horizontal.values[0]);
      assert.isAbove(horizontal.values[2], horizontal.values[1]);
      assert.isAbove(horizontal.values[3], horizontal.values[2]);
      assert.closeTo(horizontal.values[4], horizontal.values[3], 0.001, "same coordinate stays fixed");
      assert.isBelow(horizontal.values[5], horizontal.values[4]);
      const stopped = horizontal.ratio();
      window.dispatchEvent(event("pointermove", horizontal.x + 150, horizontal.y));
      assert.closeTo(horizontal.ratio(), stopped, 0.001, "pointerup stops drag");
      const repeated = await drag("horizontal", [25], "pointercancel");
      assert.isAbove(repeated.values[1], repeated.values[0]);
      const cancelled = repeated.ratio();
      window.dispatchEvent(event("pointermove", repeated.x + 150, repeated.y));
      assert.closeTo(repeated.ratio(), cancelled, 0.001, "pointercancel stops drag");
      const vertical = await drag("vertical", [25, 50, 50], "blur");
      assert.isAbove(vertical.values[1], vertical.values[0]);
      assert.isAbove(vertical.values[2], vertical.values[1]);
      assert.closeTo(vertical.values[3], vertical.values[2], 0.001);
      const blurred = vertical.ratio();
      window.dispatchEvent(event("pointermove", vertical.x, vertical.y + 120));
      assert.closeTo(vertical.ratio(), blurred, 0.001, "blur stops drag");
    } finally {
      dock.reset();
    }
  });

  it("merges nested panes through bar drops and restores the native bar", async function () {
    const nativeList = window.document.querySelector("#tab-bar-container .tab-bar-inner-container");
    const before = tabs._tabs.map((tab: any) => tab.id).sort();
    const dock = addon.data.dock;
    const leafCount = (node: any): number => !node ? 0 :
      node.kind === "leaf" ? 1 : leafCount(node.first) + leafCount(node.second);
    const dropOnLibraryBar = async (sourceID: string, onLabel: boolean) => {
      const source = window.document.querySelector(
        `#minimal-dock-overlay .md-tab[data-tab-id="${sourceID}"]`,
      );
      const libraryTab = window.document.querySelector(
        '#minimal-dock-overlay .md-tab[data-tab-id="zotero-pane"]',
      );
      assert.isNotNull(source);
      assert.isNotNull(libraryTab);
      const bar = libraryTab.closest(".md-bar");
      assert.isNotNull(bar);
      const barRect = bar.getBoundingClientRect();
      const labelRect = libraryTab.getBoundingClientRect();
      const x = onLabel ? labelRect.left + labelRect.width / 2 :
        Math.min(barRect.right - 8, labelRect.right + 24);
      if (!onLabel) assert.isAbove(x, labelRect.right, "blank bar target is outside the tab label");
      const y = barRect.top + Math.min(12, barRect.height / 2);
      const transfer = new window.DataTransfer();
      source.dispatchEvent(new window.DragEvent("dragstart", {
        bubbles: true, cancelable: true, dataTransfer: transfer,
      }));
      await Zotero.Promise.delay(30);
      const surface = window.document.querySelector("#minimal-dock-overlay .md-drag-surface");
      assert.isNotNull(surface, "drag surface appeared after dragstart");
      assert.equal(transfer.getData("application/x-minimal-dock-tab"), sourceID);
      for (const type of ["dragover", "drop"]) {
        surface.dispatchEvent(new window.DragEvent(type, {
          bubbles: true, cancelable: true, dataTransfer: transfer,
          clientX: x, clientY: y,
        }));
      }
      source.dispatchEvent(new window.DragEvent("dragend", {
        bubbles: true, dataTransfer: transfer,
      }));
      await Zotero.Promise.delay(80);
    };

    dock.split(ids[0], "right", "zotero-pane");
    dock.split(ids[1], "right", ids[0]);
    assert.equal(leafCount(dock.getState().layout), 3);
    await dropOnLibraryBar(ids[1], false);
    assert.equal(leafCount(dock.getState().layout), 2, "empty nested pane collapses");
    assert.equal(tabs.selectedID, ids[1]);
    assert.deepEqual(tabs._tabs.map((tab: any) => tab.id).sort(), before);
    await dropOnLibraryBar(ids[0], true);
    assert.isFalse(dock.getState().active, "one pane restores native layout");
    assert.isNull(nativeList.getAttribute("data-minimal-dock-hidden"));
    assert.notEqual(window.getComputedStyle(nativeList).display, "none");
    assert.equal(tabs.selectedID, ids[0]);
    assert.deepEqual(tabs._tabs.map((tab: any) => tab.id).sort(), before);
  });

  it("previews full-deck edge splits after merge and resize", async function () {
    const deck = window.document.getElementById("tabs-deck");
    const nativeTab = window.document.querySelector(`#tab-bar-container .tab[data-id="${ids[0]}"]`);
    assert.isNotNull(nativeTab);
    const originalSize = [window.outerWidth, window.outerHeight];
    const checkPreview = async (edge: "left" | "right" | "top" | "bottom", drop = false) => {
      const bounds = deck.getBoundingClientRect();
      const transfer = new window.DataTransfer();
      nativeTab.dispatchEvent(new window.DragEvent("dragstart", {
        bubbles: true, cancelable: true, dataTransfer: transfer,
      }));
      await Zotero.Promise.delay(30);
      const surface = window.document.querySelector("#minimal-dock-overlay .md-drag-surface");
      assert.isNotNull(surface);
      const x = edge === "left" ? bounds.left + 5 : edge === "right" ? bounds.right - 5 : bounds.left + bounds.width / 2;
      const y = edge === "top" ? bounds.top + 45 : edge === "bottom" ? bounds.bottom - 5 : bounds.top + bounds.height / 2;
      const options = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y };
      surface.dispatchEvent(new window.DragEvent("dragover", options));
      const preview = surface.querySelector(".md-drop")?.getBoundingClientRect();
      assert.isNotNull(preview);
      const expected = {
        left: edge === "right" ? bounds.left + bounds.width / 2 : bounds.left,
        right: edge === "left" ? bounds.left + bounds.width / 2 : bounds.right,
        top: edge === "bottom" ? bounds.top + bounds.height / 2 : bounds.top,
        bottom: edge === "top" ? bounds.top + bounds.height / 2 : bounds.bottom,
      };
      for (const side of ["left", "right", "top", "bottom"] as const) {
        assert.closeTo(preview[side], expected[side], 3, `${edge} preview ${side}`);
      }
      if (drop) surface.dispatchEvent(new window.DragEvent("drop", options));
      nativeTab.dispatchEvent(new window.DragEvent("dragend", { bubbles: true, dataTransfer: transfer }));
    };
    try {
      for (const edge of ["right", "left", "top", "bottom"] as const) await checkPreview(edge);
      const beforeWidth = deck.getBoundingClientRect().width;
      window.resizeTo(originalSize[0] - 180, originalSize[1] - 100);
      await Zotero.Promise.delay(200);
      assert.isBelow(deck.getBoundingClientRect().width, beforeWidth - 20, "window resize changed deck width");
      await checkPreview("right", true);
      assert.isTrue(addon.data.dock.getState().active);
      const pane = window.document.getElementById(ids[0])?.getBoundingClientRect();
      const bounds = deck.getBoundingClientRect();
      assert.closeTo(pane?.right ?? 0, bounds.right, 3);
      assert.closeTo(pane?.width ?? 0, bounds.width / 2, 3);
    } finally {
      addon.data.dock.reset();
      window.resizeTo(...originalSize);
    }
  });

  it("uses the pane close control and restores the native strip at one pane", async function () {
    const nativeList = window.document.querySelector("#tab-bar-container .tab-bar-inner-container");
    addon.data.dock.split(ids[0], "right", "zotero-pane");
    const close = window.document.querySelector(
      `#minimal-dock-overlay .md-tab[data-tab-id="${ids[0]}"] .md-tab-close`,
    ) as HTMLElement;
    assert.isNotNull(close);
    close.click();
    await Zotero.Promise.delay(100);
    assert.isFalse(tabs._tabs.some((tab: any) => tab.id === ids[0]));
    assert.isFalse(addon.data.dock.getState().active);
    assert.isNull(nativeList.getAttribute("data-minimal-dock-hidden"));
    assert.notEqual(window.getComputedStyle(nativeList).display, "none");
  });

  it("keeps two native PDF readers visible without recreating their browsers", async function () {
    addon.data.dock.reset();
    for (const id of ids) {
      if (tabs._tabs.some((tab: any) => tab.id === id)) tabs.close(id);
    }
    const pdf = (() => {
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ];
      for (let page = 1; page <= 2; page++) {
        const stream = `BT /F1 20 Tf 72 700 Td (Dock page ${page}) Tj ET`;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${3 + page * 2} 0 R >>`);
        objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      }
      let body = "%PDF-1.4\n";
      const offsets = [0];
      for (const [index, object] of objects.entries()) {
        offsets.push(body.length);
        body += `${index + 1} 0 obj\n${object}\nendobj\n`;
      }
      const xref = body.length;
      body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
      body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      return new TextEncoder().encode(body);
    })();
    const path = PathUtils.join(Zotero.getTempDirectory().path, "minimal-dock-smoke.pdf");
    await (globalThis as any).IOUtils.write(path, pdf);
    const readers: any[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const parent = new Zotero.Item("journalArticle");
        parent.libraryID = Zotero.Libraries.userLibraryID;
        parent.setField("title", `Dock PDF ${i + 1}`);
        await parent.saveTx();
        const attachment = await Zotero.Attachments.importFromFile({
          file: path,
          parentItemID: parent.id,
        });
        if (!pdfAttachmentID) pdfAttachmentID = attachment.id;
        const reader = await Zotero.Reader.open(attachment.id);
        await reader._initPromise;
        readers.push(reader);
      }
      const browsers = readers.map((reader) => reader._iframe);
      addon.data.dock.split(readers[0].tabID, "left", readers[1].tabID);
      await Zotero.Promise.delay(300);
      const handle = window.document.querySelector("#minimal-dock-overlay .md-handle");
      assert.isNotNull(handle);
      const hr = handle.getBoundingClientRect();
      const hx = hr.left + hr.width / 2;
      const hy = hr.top + hr.height / 2;
      const ratioBefore = addon.data.dock.getState().layout.ratio;
      const pointer = (type: string, x: number) => new window.PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 29, pointerType: "mouse", isPrimary: true,
        clientX: x, clientY: hy,
      });
      handle.dispatchEvent(pointer("pointerdown", hx));
      const shield = window.document.getElementById("minimal-dock-overlay")?.nextElementSibling;
      assert.isNotNull(shield);
      shield.dispatchEvent(pointer("pointermove", hx + 55));
      await Zotero.Promise.delay(30);
      assert.isAbove(addon.data.dock.getState().layout.ratio, ratioBefore, "divider follows pointer across PDF");
      shield.dispatchEvent(pointer("pointerup", hx + 55));
      for (const [i, reader] of readers.entries()) {
        const rect = window.document.getElementById(reader.tabID)?.getBoundingClientRect();
        assert.isAbove(rect?.width ?? 0, 0);
        assert.isAbove(rect?.height ?? 0, 0);
        assert.strictEqual(reader._iframe, browsers[i]);
        assert.isTrue(reader._iframe.isConnected);
      }
    } finally {
      addon.data.dock.reset();
      for (const reader of readers) tabs.close(reader.tabID);
    }
  });

  it("coexists with ResearchGraph in library, PDF, and workbench columns", async function () {
    if (!rgXpiPath) this.skip();
    const { AddonManager } = (globalThis as any).ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    );
    const file = Components.classes["@mozilla.org/file/local;1"].createInstance(
      Components.interfaces.nsIFile,
    );
    file.initWithPath(rgXpiPath);
    await AddonManager.installTemporaryAddon(file);
    const deadline = Date.now() + 30000;
    while (!(Zotero as any).ResearchGraph?.data.initialized) {
      if (Date.now() > deadline) throw new Error("ResearchGraph did not initialize");
      await Zotero.Promise.delay(100);
    }
    const reader = await Zotero.Reader.open(pdfAttachmentID);
    await reader._initPromise;
    const browser = reader._iframe;
    try {
      (Zotero as any).ResearchGraph.host.openWorkbench(window);
      const frame = window.document.getElementById("researchgraph-workbench-tab-frame");
      assert.isNotNull(frame);
      const dock = addon.data.dock;
      dock.split(reader.tabID, "right", "zotero-pane");
      dock.split("researchgraph-workbench-tab", "right", reader.tabID);
      await Zotero.Promise.delay(300);
      const panels = ["zotero-pane", reader.tabID, "researchgraph-workbench-tab"].map(
        (id) => window.document.getElementById(id),
      );
      for (const panel of panels) {
        assert.isAbove(panel.getBoundingClientRect().width, 0);
        assert.notEqual(window.getComputedStyle(panel).visibility, "hidden");
      }
      assert.strictEqual(reader._iframe, browser);
      assert.isTrue(browser.isConnected);
      assert.isTrue(frame.isConnected);
    } finally {
      addon.data.dock.reset();
      tabs.close(reader.tabID);
      (Zotero as any).ResearchGraph?.host.closeWorkbench(window);
    }
  });

  it("restores native tab layout when unloaded", function () {
    addon.hooks.onMainWindowUnload(window);
    assert.isUndefined(addon.data.dock);
    assert.isNull(window.document.querySelector("[data-minimal-dock-root]"));
  });
});
