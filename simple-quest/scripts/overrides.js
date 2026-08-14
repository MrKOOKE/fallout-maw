export function applyTOCOverride() {
  if (JournalEntryPage._simpleQuestBuildTOCOverride) return;
  JournalEntryPage._simpleQuestBuildTOCOverride = true;

  JournalEntryPage.buildTOC = function (html, { includeElement = true } = {}) {
    // A pseudo root heading element to start at.
    const root = { level: 0, children: [] };
    // Perform a depth-first-search down the DOM to locate heading nodes.
    const stack = [root];
    const searchHeadings = (element) => {
      if (element instanceof HTMLHeadingElement && !("noToc" in element.dataset)) {
        const node = this._makeHeadingNode(element, { includeElement });
        node.secret = !!element.closest(".secret:not(.revealed)") && !game.user.isGM;

        let parent = stack.at(-1);
        if (node.level <= parent.level) {
          stack.pop();
          parent = stack.at(-1);
        }
        parent.children.push(node);
        stack.push(node);
      }
      for (const child of element.children || []) {
        searchHeadings(child);
      }
    };
    if (Array.isArray(html)) html.forEach(searchHeadings);
    else searchHeadings(html);
    return this._flattenTOC(root.children);
  };
}
