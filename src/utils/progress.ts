export class ProgressReporter {
  private value = -1;

  constructor(
    private token: string | number | undefined,
    private notify: (params: {
      progressToken: string | number;
      progress: number;
      message?: string;
    }) => Promise<void>
  ) {}

  async send(message?: string): Promise<void> {
    if (this.token === undefined) return;
    await this.notify({ progressToken: this.token, progress: ++this.value, message });
  }
}
