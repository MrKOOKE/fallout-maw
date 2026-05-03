export class FalloutMaWDragDrop extends foundry.applications.ux.DragDrop {
  static #payload = null;

  /** @override */
  async _handleDragStart(event) {
    await this.callback(event, "dragstart");
    if ( event.dataTransfer?.items?.length ) {
      event.stopPropagation();
      let data = event.dataTransfer.getData("application/json") || event.dataTransfer.getData("text/plain");
      try {
        data = JSON.parse(data);
      } catch (_error) {
        data = null;
      }
      FalloutMaWDragDrop.#payload = data ? { event, data } : null;
    } else {
      FalloutMaWDragDrop.#payload = null;
    }
  }

  /** @override */
  async _handleDragEnd(event) {
    await this.callback(event, "dragend");
    FalloutMaWDragDrop.#payload = null;
  }

  static getPayload() {
    return FalloutMaWDragDrop.#payload?.data ?? null;
  }
}
