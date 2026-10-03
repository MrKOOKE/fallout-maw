import { transitionSoundGain } from "./sound-envelope.mjs";

let sourceClass;

/** Keep native range, elevation and wall tests; change only the volume at the audible edge. */
export function getConstructSoundSourceClass() {
  return sourceClass ??= class ConstructSoundSource extends CONFIG.Canvas.soundSourceClass {
    edgeVolume = 0.25;
    audibleRadius = 0;
    getVolumeMultiplier(listener, { easing = true } = {}) {
      if (listener && this.audibleRadius && (Math.hypot(listener.x - this.x, listener.y - this.y) > this.audibleRadius
        || Math.abs(listener.elevation - this.elevation) * canvas.dimensions.distancePixels > this.audibleRadius)) return 0;
      if (!listener || !super.getVolumeMultiplier(listener, { easing: false })) return 0;
      if (!easing) return 1;
      return this.edgeVolume + (1 - this.edgeVolume) * super.getVolumeMultiplier(listener, { easing: true });
    }
  };
}

/** A token-owned source participates in Foundry's ambient listener/perception pipeline without scene documents. */
export class ConstructSpatialSound {
  active = true;
  targetVolume = 0;
  #pending;
  #spatialGain = 0;
  #level = 1;
  #lastTarget = -1;
  constructor(token, config, { sourceId, loop = true, onEnded } = {}) {
    this.token = token; this.config = config; this.loop = loop; this.onEnded = onEnded;
    this.document = { path: config.path, volume: config.volume, walls: config.walls, easing: true };
    this.sound = loop ? game.audio.create({ src: config.path, context: game.audio.environment, singleton: true })
      : new foundry.audio.Sound(config.path, { context: game.audio.environment });
    this.source = new (getConstructSoundSourceClass())({ sourceId, object: this });
    this.source.edgeVolume = config.edgeVolume;
    if (!loop) this.sound.addEventListener("end", () => { if (this.active) onEnded?.(); });
    this.updatePosition(); this.source.add();
    canvas.perception.update({ refreshSounds: true });
    // One-shots keep their timeline even outside earshot; loops load only when audible.
    if (!loop) this.sync(false, 0);
  }
  get isAudible() {
    return this.active && !this.token.destroyed && !this.token.document.hidden
      && this.token.document.parent?.id === canvas.scene?.id;
  }
  updatePosition() {
    const token = this.token;
    const origin = token.document.getSoundOrigin();
    const elevation = origin.elevation;
    const center = token.mesh?.position ?? origin;
    const level = canvas.inferLevelFromElevation(elevation, { levels: token.document.levels });
    this.source.audibleRadius = this.config.radius * canvas.dimensions.distancePixels;
    const data = { x: center.x, y: center.y, elevation, level: level.id,
      // Native circle polygons approximate the perimeter within a pixel; the audible cutoff above stays exact.
      radius: this.source.audibleRadius + 1, walls: this.config.walls, disabled: !this.isAudible || this.loop && this.#level === 0 };
    if (Object.entries(data).every(([key, value]) => this.source.data[key] === value)) return false;
    this.source.initialize(data); return true;
  }
  sync(isAudible, volume = 0) {
    // Foundry's exact-origin branch uses 1; retain the action's configured gain there as well.
    if (this.document.volume > 0) this.#spatialGain = isAudible ? Math.min(1, Math.max(0, volume / this.document.volume)) : 0;
    this.#updatePlayback();
  }
  setEnabled(enabled) {
    this.setLevel(enabled ? 1 : 0);
  }
  setLevel(level) {
    level = Math.min(1, Math.max(0, Number(level) || 0));
    if (this.#level === level) return;
    this.#level = level;
    // A retained silent loop must not win native path grouping over another
    // audible vehicle using the same file.
    this.document.volume = this.config.volume * level;
    this.updatePosition();
    this.#updatePlayback();
    canvas.perception.update({ refreshSounds: true });
  }
  #updatePlayback(force = false) {
    this.targetVolume = this.active ? this.config.volume * this.#level * this.#spatialGain : 0;
    const managerChanged = this.loop && this.targetVolume && this.sound._manager !== this;
    if (this.loop && this.targetVolume) this.sound._manager = this;
    if (!this.active || this.#pending) return;
    const sound = this.sound;
    if (sound.playing) {
      if (this.loop && sound._manager !== this) return;
      if (!force && !managerChanged && this.#lastTarget === this.targetVolume) return;
      this.#lastTarget = this.targetVolume;
      const duration = this.targetVolume > sound.volume ? (this.config.fadeIn ?? 180) : (this.config.fadeOut ?? 300);
      transitionSoundGain(sound, this.targetVolume, duration);
      return;
    }
    if (this.loop && !this.targetVolume) return;
    this.#pending = this.#startPlayback().catch(error => {
      this.onEnded?.(); this.destroy(); console.warn("Звук конструкта", error);
    }).finally(() => {
      this.#pending = undefined;
      if (this.active) this.#updatePlayback(true);
    });
  }
  async #startPlayback() {
    const sound = this.sound;
    if (!sound.loaded) await sound.load();
    if (!this.active || (this.loop && (!this.targetVolume || sound._manager !== this))) return;
    if (sound.failed) throw new Error(`Не удалось загрузить ${this.config.path}`);
    if (!sound.playing) await sound.play({ loop: this.loop, volume: 0,
      ...(this.loop ? { offset: sound.context.currentTime % sound.duration } : {}) });
    if (!this.active && (!this.loop || sound._manager === this)) await sound.stop({ fade: 0 });
  }
  destroy() {
    if (!this.active) return;
    this.active = false; this.source.destroy();
    if (!this.loop || this.sound._manager === this) {
      const sound = this.sound, duration = sound.playing && sound.volume > 0 ? (this.config.fadeOut ?? 300) : 0;
      transitionSoundGain(sound, 0, duration);
      // A new native spatial owner may adopt this singleton while its old source
      // releases. Never enqueue Sound.stop(fade), which would stop the new owner later.
      const stop = () => {
        if (this.loop && sound._manager !== this) return;
        if (this.loop) sound._manager = null;
        void sound.stop({ fade: 0 }).catch(error => console.warn("Остановка звука конструкта", error));
      };
      if (duration) setTimeout(stop, duration); else stop();
    }
    canvas.perception.update({ refreshSounds: true });
  }
}
