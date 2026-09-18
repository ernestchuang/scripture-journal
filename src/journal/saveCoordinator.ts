import type { Entry, EntryContent } from '../domain';
import type { JournalApi } from '../platform/journal';

/** One writer per open entry; optimistic revision checks remain enforced by storage. */
export class SaveCoordinator {
  content: EntryContent;
  revisionId: string | null;
  generation: number;
  savedGeneration: number;
  status: 'unsaved' | 'saving' | 'saved' | 'finished' | 'error';
  error = '';
  private queue: Promise<unknown> = Promise.resolve();
  private pendingFinish = false;

  constructor(
    readonly id: string,
    private api: JournalApi,
    content: EntryContent,
    entry: Entry | undefined,
    private changed: () => void,
    private committed: (entry: Entry) => void,
  ) {
    this.content = structuredClone(content);
    this.revisionId = entry?.workingRevisionId ?? null;
    this.generation = entry ? 0 : 1;
    this.savedGeneration = 0;
    this.status = entry?.workingRevisionId === entry?.publishedRevisionId && entry
      ? 'finished' : entry ? 'saved' : 'unsaved';
  }

  update(content: EntryContent) {
    this.content = structuredClone(content);
    this.generation++;
    if (this.status !== 'error') this.status = 'unsaved';
    this.changed();
  }

  get dirty() { return this.generation !== this.savedGeneration || this.pendingFinish; }

  flush(finish = false): Promise<void> {
    // Publish intent must be visible to an already-running save. Otherwise that
    // save can persist a newer edit as another draft before the queued finish runs.
    if (finish) this.pendingFinish = true;
    const task = this.queue.catch(() => undefined).then(async () => {
      while (this.dirty) {
        const publish = this.pendingFinish;
        const generation = this.generation;
        const content = structuredClone(this.content);
        this.status = 'saving';
        this.error = '';
        this.changed();
        try {
          const entry = await this.api.saveEntry({
            entryId: this.id, expectedRevisionId: this.revisionId,
            content, finish: publish,
          });
          this.revisionId = entry.workingRevisionId;
          this.savedGeneration = generation;
          this.committed(entry);
          if (publish) this.pendingFinish = false;
          this.status = this.dirty ? 'unsaved' : publish ? 'finished' : 'saved';
          this.changed();
        } catch (error) {
          this.status = 'error';
          this.error = error instanceof Error ? error.message : String(error);
          this.changed();
          throw error;
        }
      }
    });
    this.queue = task;
    return task;
  }
}
