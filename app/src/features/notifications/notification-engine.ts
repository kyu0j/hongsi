import { emptyStatus, ID_BASE, reminderPlan, type Channel, type ChannelStatus, type NotificationIntent, type Permission, type Reminder } from './notification-model';
type ScheduledReminder = { id: number; key: string; signature: string };
type ScheduledPlan = { account: string | null; entries: ScheduledReminder[] };
export interface NotificationDriver {
  native: boolean;
  ios: boolean;
  permission(ask: boolean): Promise<Permission>;
  pending(): Promise<number[]>;
  cancel(ids: number[]): Promise<void>;
  send(id: number, reminder: Reminder, intent: NotificationIntent, scheduled: boolean): Promise<void>;
  readScheduled?(channel: Channel): ScheduledPlan | null;
  writeScheduled?(channel: Channel, plan: ScheduledPlan): void;
}
type Status = (channel: Channel, value: ChannelStatus) => void;
const CHANNELS: Channel[] = ['seat', 'due'];
const MAX_DELAY = 2_000_000_000;

export class ReminderScheduler {
  private plans: Record<Channel, Reminder[]> = { seat: [], due: [] };
  private timers: Record<Channel, ReturnType<typeof setTimeout>[]> = { seat: [], due: [] };
  private signatures: Partial<Record<Channel, string>> = {};
  private reservations: Record<Channel, ScheduledReminder[]> = { seat: [], due: [] };
  private loaded: Record<Channel, boolean> = { seat: false, due: false };
  private preserveUntilLoaded: Record<Channel, boolean> = { seat: false, due: false };
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;
  private account: string | null = null;
  enabled = true;
  remote = false;
  permission: Permission = 'unknown';
  constructor(private driver: NotificationDriver, private status: Status, private onPermission: (p: Permission) => void) {}

  reset(account: string | null) {
    this.revision++;
    this.account = account;
    this.plans = { seat: [], due: [] };
    this.signatures = {};
    this.loaded = { seat: false, due: false };
    for (const c of CHANNELS) {
      const stored = this.driver.readScheduled?.(c);
      const matching = !!account && stored?.account === account;
      const ids = new Set<number>(), keys = new Set<string>();
      this.reservations[c] = matching && Array.isArray(stored.entries) ? stored.entries.filter((entry) => {
        if (!entry || !Number.isInteger(entry.id) || entry.id < ID_BASE[c] || entry.id >= ID_BASE[c] + 500
          || typeof entry.key !== 'string' || typeof entry.signature !== 'string' || ids.has(entry.id) || keys.has(entry.key)) return false;
        ids.add(entry.id); keys.add(entry.key);
        return true;
      }) : [];
      this.preserveUntilLoaded[c] = matching;
      this.clearTimers(c);
      this.status(c, emptyStatus());
    }
    return this.refresh(true);
  }
  set(channel: Channel, reminders: Reminder[]) {
    this.plans[channel] = reminders;
    this.loaded[channel] = true;
    this.preserveUntilLoaded[channel] = false;
    return this.refresh();
  }
  async allow(ask = false) {
    this.permission = await this.driver.permission(ask);
    this.onPermission(this.permission);
    await this.refresh(true);
    return this.permission === 'granted';
  }
  refresh(force = false): Promise<void> {
    const rev = this.revision;
    const run = this.tail.then(async () => {
      if (rev !== this.revision) return;
      try {
        this.permission = await this.driver.permission(false);
        if (rev !== this.revision) return;
        this.onPermission(this.permission);
        for (const c of CHANNELS) {
          if (rev !== this.revision) return;
          await this.reconcile(c, rev, force);
        }
      } catch {
        if (rev === this.revision) for (const c of CHANNELS) this.status(c, { ...emptyStatus(), error: '알림 설정을 확인하지 못했어요.' });
      }
    });
    this.tail = run.catch(() => {});
    return run;
  }
  private clearTimers(c: Channel) { this.timers[c].forEach(clearTimeout); this.timers[c] = []; }
  private async reconcile(c: Channel, rev: number, force: boolean) {
    const active = this.account && this.enabled && !this.remote;
    const limit = c === 'seat' ? 6 : this.driver.ios ? 56 : 400;
    const { all, selected, deferred } = reminderPlan(active ? this.plans[c] : [], limit, Date.now(), this.driver.native ? Infinity : MAX_DELAY);
    const allowed = this.permission === 'granted';
    if (this.driver.native && active && allowed && !this.loaded[c] && this.preserveUntilLoaded[c]) return;
    const plan = allowed ? selected : [];
    const signature = JSON.stringify([this.account, this.enabled, this.remote, this.permission, all.length, deferred, plan]);
    if (!force && this.signatures[c] === signature) return;
    const result: ChannelStatus = { planned: all.length, scheduled: 0, deferred, next: null, checkedAt: Date.now(), error: '' };
    this.clearTimers(c);
    const base = ID_BASE[c];
    try {
      if (this.driver.native) {
        const pending = await this.driver.pending();
        if (rev !== this.revision) return;
        const mine = new Set(pending.filter((id) => id >= base && id < base + 500));
        const previous = new Map(this.reservations[c].map((entry) => [entry.key, entry]));
        const used = new Set<number>();
        const desired: ScheduledReminder[] = [];
        for (const r of plan) {
          const entry = previous.get(r.key);
          if (!entry) continue;
          used.add(entry.id);
          desired.push({ id: entry.id, key: r.key, signature: JSON.stringify([this.account, r]) });
        }
        for (const r of plan) {
          if (previous.has(r.key)) continue;
          let id = base;
          while (used.has(id)) id++;
          if (id >= base + 500) throw new Error('limit');
          used.add(id);
          desired.push({ id, key: r.key, signature: JSON.stringify([this.account, r]) });
        }
        const retained = new Set(desired.filter((entry) => previous.get(entry.key)?.signature === entry.signature
          && mine.has(entry.id)).map((entry) => entry.id));
        const removed = [...mine].filter((id) => !retained.has(id));
        if (removed.length) await this.driver.cancel(removed);
        if (rev !== this.revision) return;
        this.reservations[c] = desired.filter((entry) => retained.has(entry.id));
        this.persist(c);
        const reminders = new Map(plan.map((reminder) => [reminder.key, reminder]));
        try {
          for (const entry of desired) {
            if (retained.has(entry.id)) continue;
            const reminder = reminders.get(entry.key)!;
            if (reminder.at <= Date.now()) continue;
            await this.driver.send(entry.id, reminder, this.intent(reminder), true);
            if (rev !== this.revision) return;
            this.reservations[c].push(entry);
          }
        } finally {
          if (rev === this.revision) this.persist(c);
        }
        const verified = new Set(await this.driver.pending());
        if (rev !== this.revision) return;
        this.reservations[c] = this.reservations[c].filter((entry) => verified.has(entry.id));
        this.persist(c);
        const accepted = new Set(this.reservations[c].map((entry) => entry.key));
        result.scheduled = accepted.size;
        result.next = plan.find((reminder) => accepted.has(reminder.key))?.at ?? null;
        if (desired.some((entry) => !accepted.has(entry.key) && reminders.get(entry.key)!.at > Date.now())) throw new Error('missing');
      } else {
        for (const [i, r] of plan.entries()) {
          const intent = this.intent(r);
          this.timers[c].push(setTimeout(() => {
            if (rev !== this.revision || !this.enabled || this.remote) return;
            if (Date.now() - r.at <= 10 * 60_000) {
              void this.driver.send(base + i, r, intent, false).catch(() => this.status(c, { ...result, error: '알림을 표시하지 못했어요.' }));
            }
            void this.refresh();
          }, Math.max(0, r.at - Date.now())));
        }
        result.scheduled = plan.length;
        result.next = plan[0]?.at ?? null;
      }
      this.signatures[c] = signature;
    } catch {
      delete this.signatures[c];
      result.error = '예약 알림을 갱신하지 못했어요.';
    }
    if (rev === this.revision) this.status(c, result);
  }
  private persist(c: Channel) {
    this.driver.writeScheduled?.(c, { account: this.account, entries: this.reservations[c] });
  }
  private intent(r: Reminder): NotificationIntent { return { version: 1, account: this.account!, target: r.target, at: r.at }; }
}
