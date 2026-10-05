/** Editor-only camera. Model coordinates and Actor data never change when navigating. */
export class ConstructPreviewCamera {
  #zoom = 1;
  #x = 0;
  #y = 0;
  #width = 0;
  #height = 0;
  #frame;
  #preview;
  #output;
  #drag;

  get scaleLabel() { return `${Math.round(this.#zoom * 100)}%`; }
  get panning() { return Boolean(this.#drag); }

  attach(frame, preview, { signal, output, canNavigate = () => true } = {}) {
    this.#finishPan();
    this.#frame = frame;
    this.#preview = preview;
    this.#output = output;
    // Capture RMB before the anchor editor sees it, including directly over a marker.
    const options = { signal, capture: true };
    frame.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); }, options);
    frame.addEventListener("wheel", event => {
      event.preventDefault();
      event.stopPropagation();
      if (this.panning || !canNavigate()) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1;
      const factor = Math.exp(Math.max(-Math.log(2), Math.min(Math.log(2), -event.deltaY * unit * .0015)));
      const zoom = Math.max(.25, Math.min(8, this.#zoom * factor));
      const rect = frame.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      const ratio = zoom / this.#zoom;
      this.#x = x - (x - this.#x) * ratio;
      this.#y = y - (y - this.#y) * ratio;
      this.#zoom = zoom;
      this.#apply();
    }, { ...options, passive: false });
    frame.addEventListener("pointerdown", event => {
      if (event.button !== 2 || this.panning || !canNavigate()) return;
      event.preventDefault();
      event.stopPropagation();
      this.#drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: this.#x, panY: this.#y };
      frame.setPointerCapture(event.pointerId);
      frame.classList.add("panning");
    }, options);
    frame.addEventListener("pointermove", event => {
      if (!this.#drag || this.#drag.id !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      this.#x = this.#drag.panX + event.clientX - this.#drag.x;
      this.#y = this.#drag.panY + event.clientY - this.#drag.y;
      this.#apply();
    }, options);
    const finish = event => {
      if (!this.#drag || this.#drag.id !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      this.#finishPan();
    };
    frame.addEventListener("pointerup", finish, options);
    frame.addEventListener("pointercancel", finish, options);
    frame.addEventListener("lostpointercapture", finish, options);
    this.#apply();
  }

  fit(width, height) {
    // Keep the same model area centered when resizing the window or its preview.
    if (this.#width) this.#x *= width / this.#width;
    if (this.#height) this.#y *= height / this.#height;
    this.#width = width;
    this.#height = height;
    this.#apply();
  }

  reset() {
    this.#finishPan();
    this.#zoom = 1;
    this.#x = this.#y = 0;
    this.#apply();
  }

  dispose() {
    this.#finishPan();
    this.#frame = this.#preview = this.#output = null;
  }

  #finishPan() {
    const id = this.#drag?.id;
    this.#drag = null;
    this.#frame?.classList.remove("panning");
    if (id !== undefined && this.#frame?.hasPointerCapture(id)) this.#frame.releasePointerCapture(id);
  }

  #apply() {
    if (!this.#preview || !this.#width || !this.#height) return;
    // Resize the model instead of scaling its DOM: anchor handles stay the same size.
    this.#preview.style.width = `${this.#width * this.#zoom}px`;
    this.#preview.style.height = `${this.#height * this.#zoom}px`;
    this.#preview.style.transform = `translate(${this.#x}px, ${this.#y}px)`;
    if (this.#output) this.#output.textContent = this.scaleLabel;
  }
}
