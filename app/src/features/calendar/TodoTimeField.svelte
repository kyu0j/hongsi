<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../../shared/ui/Icon.svelte';
  import TimeWheel from '../../shared/ui/TimeWheel.svelte';

  let { value = $bindable(''), disabled = false }: { value: string; disabled?: boolean } = $props();
  const id = $props.id();
  const allDay = $derived(!value);
  let remembered = '09:00';
  let draft = $state('');
  let expanded = $state(false);
  let above = $state(false);
  let root: HTMLDivElement;
  let input: HTMLInputElement;
  let field: HTMLDivElement;
  const positions = [0, 1, 4, 5];
  const carets = [...positions, 6];
  type Edit = { text: string; start: number; end: number };
  let undo: Edit[] = [];
  let redo: Edit[] = [];
  let keyboardValue: string | null = null;

  $effect(() => {
    const next = value;
    untrack(() => {
      if (next) remembered = next;
      if (next !== keyboardValue) {
        draft = display(next || remembered);
        undo = [];
        redo = [];
      }
      keyboardValue = null;
    });
  });
  $effect(() => {
    if (allDay || disabled) expanded = false;
  });

  function display(text: string) {
    const [hour, minute] = text.split(':');
    return `${hour}시 ${minute}분`;
  }

  function normalized(text: string) {
    let clean = text.trim();
    const korean = /^([\d-]{1,2})\s*시\s*([\d-]{1,2})\s*분$/.exec(clean);
    if (korean) {
      const hour = korean[1].replace(/-/g, '');
      const minute = korean[2].replace(/-/g, '');
      if (!hour || !minute) return null;
      clean = `${hour}:${minute.padStart(2, '0')}`;
    }
    if (/^\d{3,4}$/.test(clean)) clean = clean.slice(0, -2) + ':' + clean.slice(-2);
    const match = /^(\d{1,2}):(\d{2})$/.exec(clean);
    if (!match || +match[1] > 23 || +match[2] > 59) return null;
    return `${match[1].padStart(2, '0')}:${match[2]}`;
  }

  function commit() {
    if (allDay || disabled) return;
    const next = normalized(draft);
    if (next) value = next;
    draft = display(next ?? value);
    queueMicrotask(snapCaret);
  }

  function nearestCaret(position: number) {
    return carets.reduce((nearest, candidate) => Math.abs(candidate - position) < Math.abs(nearest - position) ? candidate : nearest);
  }

  function snapCaret() {
    if (!input || document.activeElement !== input || input.selectionStart !== input.selectionEnd) return;
    const current = input.selectionStart ?? 0;
    const next = nearestCaret(current);
    if (next !== current) input.setSelectionRange(next, next);
  }

  function moveCaret(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
    event.preventDefault();
    const start = input.selectionStart ?? 0, end = input.selectionEnd ?? 0;
    const backward = input.selectionDirection === 'backward';
    const anchor = backward ? end : start;
    const focus = backward ? start : end;
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 6;
    else if (event.ctrlKey || event.metaKey) next = event.key === 'ArrowLeft' ? 0 : 6;
    else if (!event.shiftKey && start !== end) next = nearestCaret(event.key === 'ArrowLeft' ? start : end);
    else next = event.key === 'ArrowLeft'
      ? [...carets].reverse().find(position => position < focus) ?? 0
      : carets.find(position => position > focus) ?? 6;
    if (event.shiftKey) input.setSelectionRange(Math.min(anchor, next), Math.max(anchor, next), next < anchor ? 'backward' : 'forward');
    else input.setSelectionRange(next, next);
    return true;
  }

  function currentEdit(): Edit {
    return { text: draft, start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 };
  }

  function renderEdit(edit: Edit) {
    draft = edit.text;
    input.value = draft;
    const previous = value.split(':');
    const next = [draft.slice(0, 2), draft.slice(4, 6)].map((part, index) => {
      const digits = part.replace(/-/g, '');
      return digits && Number(digits) <= (index === 0 ? 23 : 59) ? digits.padStart(2, '0') : previous[index];
    }).join(':');
    if (next !== value) {
      keyboardValue = next;
      value = next;
    }
    queueMicrotask(() => {
      if (document.activeElement === input) {
        const collapsed = edit.start === edit.end;
        input.setSelectionRange(collapsed ? nearestCaret(edit.start) : edit.start, collapsed ? nearestCaret(edit.end) : edit.end);
      }
    });
  }

  function editDigits(kind: string, text = '') {
    if (allDay || disabled) return;
    const previous = currentEdit();
    const digits = text.normalize('NFKC').replace(/\D/g, '');
    if (kind.startsWith('insert') && !digits) return;
    const slots = positions.map(position => /\d/.test(draft[position] ?? '') ? draft[position] : '-');
    let start = previous.start, end = previous.end;
    if (kind === 'deleteWordBackward') start = 0;
    if (kind === 'deleteWordForward') end = 7;
    let cursor = start;
    if (start !== end) {
      positions.forEach((position, i) => { if (position >= start && position < end) slots[i] = '-'; });
    } else if (kind.startsWith('delete')) {
      const index = kind.endsWith('Backward')
        ? positions.indexOf([...positions].reverse().find(position => position < start) ?? -1)
        : positions.findIndex(position => position >= start);
      if (index >= 0) { slots[index] = '-'; cursor = positions[index]; }
    }
    if (kind.startsWith('insert')) {
      let index = positions.findIndex(position => position >= start);
      if (index < 0) return;
      for (const digit of digits) {
        if (index >= slots.length) break;
        slots[index++] = digit;
      }
      cursor = positions[index] ?? 6;
    }
    const next = `${slots[0]}${slots[1]}시 ${slots[2]}${slots[3]}분`;
    if (next !== previous.text) {
      undo = [...undo.slice(-79), previous];
      redo = [];
    }
    renderEdit({ text: next, start: cursor, end: cursor });
  }

  function beforeInput(event: InputEvent) {
    if (!event.cancelable) return;
    event.preventDefault();
    if (event.inputType.startsWith('insert')) editDigits(event.inputType, event.data ?? '');
    else if (event.inputType.startsWith('delete')) editDigits(event.inputType);
  }

  function paste(event: ClipboardEvent) {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    editDigits('insertFromPaste', normalized(text)?.replace(':', '') ?? text);
  }

  function cut(event: ClipboardEvent) {
    event.preventDefault();
    const edit = currentEdit();
    if (edit.start === edit.end) return;
    event.clipboardData?.setData('text/plain', draft.slice(edit.start, edit.end));
    editDigits('deleteByCut');
  }

  function show() {
    if (allDay || disabled) return;
    const bounds = field.getBoundingClientRect();
    const body = field.closest('.body')?.getBoundingClientRect();
    above = !!body && body.bottom - bounds.bottom < 224 && bounds.top - body.top > 224;
    expanded = true;
  }

  function edited(event: Event) {
    const element = event.target as HTMLInputElement;
    element.value = draft;
  }

  function keydown(event: KeyboardEvent) {
    if (!root?.contains(event.target as Node)) return;
    if (event.target === input && moveCaret(event)) return;
    if (event.target === input && (event.metaKey || event.ctrlKey)
      && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      event.stopPropagation();
      const forward = event.key.toLowerCase() === 'y' || event.shiftKey;
      const next = (forward ? redo : undo).pop();
      if (next) {
        (forward ? undo : redo).push(currentEdit());
        renderEdit(next);
      }
      return;
    }
    if ((event.key === 'Escape' && expanded) || (event.key === 'Enter' && event.target === input)) {
      event.preventDefault();
      event.stopPropagation();
      commit();
      expanded = false;
      input?.focus();
    } else if (event.key === 'ArrowDown' && event.altKey) {
      event.preventDefault();
      show();
    }
  }

  function outside(event: PointerEvent) {
    if (expanded && !root?.contains(event.target as Node)) {
      commit();
      expanded = false;
    }
  }

  function leave(event: FocusEvent) {
    if (event.relatedTarget && !root?.contains(event.relatedTarget as Node)) {
      commit();
      expanded = false;
    }
  }
</script>

<svelte:document onpointerdown={outside} onkeydown={keydown} onselectionchange={snapCaret} />
<div class="time-field" bind:this={root} onfocusout={leave} role="group" aria-label="시간 설정">
  <div class="heading">
    <label for={id}>시간</label>
  </div>
  <div class="anchor" bind:this={field}>
    <div class="input-shell" class:disabled={allDay || disabled}>
      <button type="button" aria-label="시간 선택" aria-expanded={expanded} disabled={allDay || disabled}
        onclick={() => { if (expanded) { commit(); expanded = false; } else show(); }}>
        <Icon name="clock" size={24} />
      </button>
      <input id={id} bind:this={input} type="text" inputmode="numeric" autocomplete="off"
        value={allDay ? '' : draft} placeholder="--시 --분" disabled={allDay || disabled} spellcheck="false"
        aria-label="시간 (24시간)" role="combobox" aria-haspopup="dialog" aria-autocomplete="none" aria-expanded={expanded} aria-controls={expanded ? `${id}-picker` : undefined}
        onclick={() => { snapCaret(); show(); }} onfocus={snapCaret} onbeforeinput={beforeInput} oninput={edited} onpaste={paste} oncut={cut} onblur={commit} />
    </div>
    {#if expanded}
      <div class="popover" class:above id={`${id}-picker`} role="dialog" aria-label="시간 선택 휠" tabindex="-1">
        <TimeWheel bind:value={() => value || remembered, (next) => { value = next; }} minuteStep={1} />
      </div>
    {/if}
  </div>
  <label class="all-day">
    <input type="checkbox" checked={allDay} onchange={(event) => { value = event.currentTarget.checked ? '' : remembered; }} {disabled} />
    <span class="box" aria-hidden="true"><Icon name="tick" size={12} stroke={2.4} /></span>
    <span>하루 종일</span>
  </label>
</div>

<style>
  .time-field { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0; align-content: start; }
  .heading { grid-column: 1; grid-row: 1; display: flex; align-items: center; min-height: 20px; font-size: 13px; font-weight: 650; color: var(--text-2); }
  .all-day { grid-column: 1; grid-row: 1; align-self: center; justify-self: end; display: inline-flex; align-items: center; gap: 6px; min-height: 20px; cursor: pointer; font-size: 13px; font-weight: 600; color: var(--text-2); white-space: nowrap; }
  .all-day input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .box { width: 16px; height: 16px; border: 1px solid var(--border-strong); border-radius: 5px; display: grid; place-items: center; background: var(--surface-2); color: transparent; }
  .all-day input:checked + .box { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
  .all-day input:focus-visible + .box { outline: 2px solid var(--primary); outline-offset: 3px; }
  .all-day input:disabled ~ span { opacity: .45; cursor: default; }
  .anchor { grid-column: 1; grid-row: 2; position: relative; }
  .input-shell { display: flex; height: 46px; border-radius: 12px; border: 1px solid var(--border-strong); background: var(--surface-2); }
  .input-shell:focus-within { border-color: var(--primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary) 18%, transparent); }
  .input-shell.disabled { opacity: .45; }
  .input-shell input { flex: 1; width: 0; min-width: 0; padding: 0 12px 0 0; border: 0; border-radius: 12px; background: transparent; outline: none; font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; font-kerning: none; font-variant-ligatures: none; color: var(--text); }
  .input-shell button { flex: none; width: 44px; padding-left: 12px; display: grid; place-items: center start; color: var(--text-3); border-radius: 10px; }
  .input-shell button:focus-visible { outline: 2px solid var(--primary); outline-offset: -4px; }
  .input-shell button:disabled { cursor: default; }
  .popover { position: absolute; top: calc(100% + 8px); left: 0; right: 0; z-index: 4; padding: 6px; border: 1px solid var(--modal-border); border-radius: 18px; background: var(--modal-surface); box-shadow: var(--shadow-lg); }
  .popover.above { top: auto; bottom: calc(100% + 8px); }
  @media (max-width: 559px) {
    .all-day { gap: 5px; font-size: 12px; }
    .input-shell input { padding-right: 6px; font-size: 14px; }
    .input-shell button { width: 30px; padding-left: 6px; }
    .input-shell button :global(svg) { width: 20px; height: 20px; }
    .popover { left: auto; width: 180px; }
  }
</style>
