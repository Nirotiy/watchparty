/** One media/wall mapping for packet pacing, video presentation and audio output. */
export class MediaClock {
  private media = 0;
  private wall = 0;
  private running = false;
  rate = 1;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get currentTime() {
    return this.media + (this.running ? (this.now() - this.wall) * this.rate / 1000 : 0);
  }

  dueMs(seconds: number) {
    return this.wall + (seconds - this.media) * 1000 / this.rate;
  }

  seek(seconds: number) {
    this.media = Math.max(0, seconds);
    this.wall = this.now();
  }

  play() {
    if (this.running) return;
    this.wall = this.now();
    this.running = true;
  }

  pause() {
    this.media = this.currentTime;
    this.wall = this.now();
    this.running = false;
  }

  setRate(rate: number) {
    if (!Number.isFinite(rate) || rate <= 0 || rate > 4 || rate === this.rate) return;
    this.media = this.currentTime;
    this.wall = this.now();
    this.rate = rate;
  }
}
