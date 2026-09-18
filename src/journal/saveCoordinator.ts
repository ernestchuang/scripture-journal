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
  /** Generation selected by an explicit Finish request, if it has not committed. */
  private finishGeneration: number | null = null;

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
    // A failed Finish may be retried only for the generation the user selected.
    // Later edits remain drafts until the user explicitly finishes them.
    if (this.finishGeneration !== null && this.generation > this.finishGeneration) {
      this.finishGeneration = null;
    }
    if (this.status !== 'error') this.status = 'unsaved';
    this.changed();
  }

  get dirty() { return this.generation !== this.savedGeneration || this.finishGeneration !== null; }

  flush(finish = false): Promise<void> {
    // Publish intent must be visible to an already-running save, but only for
    // this exact generation. A later edit must not be published implicitly.
    if (finish) this.finishGeneration = this.generation;
    const task = this.queue.catch(() => undefined).then(async () => {
      while (this.dirty) {
        const generation = this.generation;
        const publish = this.finishGeneration === generation;
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
          if (publish) this.finishGeneration = null;
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
