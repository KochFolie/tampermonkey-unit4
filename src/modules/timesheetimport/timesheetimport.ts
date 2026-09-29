import { Configuration } from "../../configuration";
import { AbstractModule } from '../AbstractModule';
import { Utils } from "../global/utils";
import { Importer } from './importer/importer';
import { CloseEditingModeTask, SanityCheckTask } from "./importer/importtask";
import { WorkingEndImportTask, WorkingRowImportTask, WorkingStartImportTask } from "./importer/workinghours";
import { ActivityImportTask, DescriptionImportTask, FtZStartWorkOrderImportTask, HoursImportTask, RowHoursImportTask, StartBreakRowImportTask, StartWorkOrderImportTask, TimecodeImportTask, WOImportTask, WorkOrder, WorkOrderImportTask, WorkOrderSummaryTask } from "./importer/workorders";
import './timesheetimport.less';

export type ImportWorkingHoursDay = {
  start: string,
  end: string;
}
export type ImportWorkingHours = { [date: string]: ImportWorkingHoursDay };

export type ImportWorkOrderTime = {
  date: string;
  hours: string;
}
export type ImportWorkOrder = {
  timeCode?: string;
  workOrder: string;
  activity?: string;
  description: string;
  time: ImportWorkOrderTime[];
}

type ImportFormat = {
  days: ImportWorkingHours,
  entries: ImportWorkOrder[];
}
type ImportFormatOld = ImportWorkOrder[];

export type SanityDaily = { [day: string]: { hours: number, breaks: number, workingTime: number } };

// one parsed row of the "Florians tollige Zeiterfassung" day-log (columns A-I)
export type FtZEntry = {
  weekday: string;        // B - Wochentag, forward-filled from merged cell
  start: string;          // C - Anfang (HH:MM)
  end: string;            // D - Ende (HH:MM)
  duration: string;       // E - Dauer (HH:MM)
  workOrder: string;      // F - Echte Workorder (authoritative, must match the 000000-00000 format)
  workOrderInput: string; // G - Workorder (raw autocomplete text or workorder)
  ticket: string;         // H - Ticket
  comment: string;        // I - Kommentar
}

export class Timesheetimport extends AbstractModule {
  // max waiting time for a field to be available / get focus
  private static readonly retrySeconds = 10;

  // valid Unit4 workorder format, e.g. 950100-10005
  private static readonly workOrderPattern = /^\d{6}-\d{5}$/;

  // weekday tokens of the merged "Wochentag" column
  private static readonly ftzWeekdays = new Set(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);

  // German weekday (column B) -> English grid header token
  private static readonly ftzWeekdayToken: { [de: string]: string } = {
    'Mo': 'mon', 'Di': 'tue', 'Mi': 'wed', 'Do': 'thu', 'Fr': 'fri', 'Sa': 'sat', 'So': 'sun'
  };

  // a single time cell, e.g. 09:00 or 46:15
  private static readonly ftzTimeRe = /^\d{1,2}:\d{2}$/;

  // localStorage key for remembering how the user corrected invalid column-F workorders
  private static readonly ftzCorrectionStorageKey = 'ftzWorkOrderCorrections';

  // sessionStorage key for the pasted text while the page reloads to open a row for the workorder lookup
  private static readonly ftzPendingDialogStorageKey = 'ftzPendingDialog';

  private standardAddBtn!: HTMLButtonElement;
  // shared import dialog for JSON and FtZ data (the review view is FtZ only)
  private ftzDialog!: HTMLElement;
  private ftzDialogEntry!: HTMLTextAreaElement;
  private ftzCorrectionContainer!: HTMLElement;
  private ftzOkButton!: HTMLButtonElement;
  private ftzEntries: FtZEntry[] = [];
  // bookings on weekdays the current timesheet does not contain (skipped by the import)
  private ftzOutsideEntries: FtZEntry[] = [];
  private ftzCorrectionInputs: Map<string, HTMLInputElement> = new Map();
  // a row has already been opened for the workorder lookup, do not try again
  private ftzLookupRowRequested = false;
  private buttonFailed!: HTMLButtonElement;

  // ----------------------------------------------------------------------
  // Time Entry Screen Action Buttons
  // ----------------------------------------------------------------------

  private section!: HTMLElement;
  private sectionWorkingHours!: HTMLElement;
  //private progress!: HTMLElement;

  public initModule(): Promise<void> {
    if (Configuration.getInstance().experimentalJsonImport() || Configuration.getInstance().experimentalFtZExcelImport()) {
      // add import button and progress if this feature is enabled in configuration
      document.querySelectorAll('h2.SectionTitle').forEach(e => {
          if (e.textContent.startsWith('Time entry')) {
            let section = e.closest('.u4-section-placeholder');
            if (section != null) {
              this.section = section as HTMLElement;
              this.section.classList.add("timeentry-section");
              this.setActive();
            }
          } else if (e.textContent.startsWith('Working hours')) {
            let section = e.closest('.u4-section-placeholder');
            if (section != null) {
              this.sectionWorkingHours = section as HTMLElement;
              this.sectionWorkingHours.classList.add("workinghours-section");

            }
          }
      });
    }
    return Promise.resolve();
  }

  public executeModule(): void {
    if(this.section){
      const table = this.section.querySelector('.TableButtonRow')?.closest('table');

      if(table){
        //get Instance of original 'Add' btn
        table.querySelectorAll('button').forEach(e => {
          if (e.textContent === 'Add') {
            this.standardAddBtn = e;
          }
        });

        if (this.standardAddBtn) {
          // one import button for JSON and FtZ data, the format is detected on import
          this.addImportUI(table);
          this.addFailedButtonUI(table);
        }

        // Run pending tasks from importer
        const importer = Importer.getInstance();
        WOImportTask.setSection(this.section);
        WOImportTask.setAddButton(this.standardAddBtn);
        if (this.ftzDialog) {
          this.restoreFtZDialog();
        }
        this.runTasks();
      }
    }
  }

  private addFailedButtonUI(table: HTMLTableElement) {
    // create new button for last errors
    const buttonFailedCell = document.createElement("td");
    table.rows[0].insertBefore(buttonFailedCell, this.standardAddBtn.parentElement);
    buttonFailedCell.classList.add('Button');
    buttonFailedCell.style.paddingLeft = "0";
    this.buttonFailed = document.createElement("button");
    this.buttonFailed.setAttribute("id", "json-import-failed-btn");
    this.buttonFailed.setAttribute("type", "button");
    this.buttonFailed.setAttribute("role", "button");
    this.buttonFailed.setAttribute("title", "Show last failed imports");
    this.buttonFailed.setAttribute("onclick", "");
    this.buttonFailed.classList.add('BaseButton');
    this.buttonFailed.classList.add('SectionButton');
    this.buttonFailed.innerHTML = "<span>failed</span>"
    this.buttonFailed.addEventListener("click", () => {
      Utils.showDialog(sessionStorage.getItem("import_failed_summary") ?? 'No failed actions');
    });
    this.failedUpdate();
    buttonFailedCell.appendChild(this.buttonFailed);
  }

  private addImportUI(table: HTMLTableElement) {
    // create modal import dialog for JSON and "Florians tollige Zeiterfassung" Excel data
    this.ftzDialog = document.createElement("div");
    this.ftzDialog.classList.add("modalDialog");
    this.ftzDialog.style.display = 'none';

    // paste area for JSON or the tab-separated Excel export
    this.ftzDialogEntry = document.createElement("textarea");
    this.ftzDialogEntry.setAttribute("placeholder", "JSON oder Excel-Daten hier einfügen (Excel: Select-All → Copy aus Florians tollige Zeiterfassung)");
    this.ftzDialog.appendChild(this.ftzDialogEntry);

    // correction area for invalid workorders (hidden until validation fails)
    this.ftzCorrectionContainer = document.createElement("div");
    this.ftzCorrectionContainer.classList.add("ftzCorrection");
    this.ftzCorrectionContainer.style.display = 'none';
    this.ftzDialog.appendChild(this.ftzCorrectionContainer);

    const dialogButtons = document.createElement("div");
    dialogButtons.classList.add("modalDialog__buttons");
    this.ftzDialog.appendChild(dialogButtons);

    this.ftzOkButton = document.createElement("button");
    this.ftzOkButton.setAttribute("type", "button");
    this.ftzOkButton.classList.add("RibbonInlineButton", "RibbonInlineButtonHappy");
    this.ftzOkButton.innerHTML = "<span>Start Import</span>";
    this.ftzOkButton.addEventListener('click', this.actionFtZExcelImport.bind(this));
    dialogButtons.appendChild(this.ftzOkButton);

    const dialogCancel = document.createElement("button");
    dialogCancel.setAttribute("type", "button");
    dialogCancel.classList.add("RibbonInlineButton");
    dialogCancel.innerHTML = "<span>Cancel</span>";
    dialogCancel.addEventListener('click', this.actionFtZExcelClose.bind(this));
    dialogButtons.appendChild(dialogCancel);

    document.body.appendChild(this.ftzDialog);

    // create new button for the import
    const buttonImportCell = document.createElement("td");
    table.rows[0].insertBefore(buttonImportCell, this.standardAddBtn.parentElement);
    buttonImportCell.classList.add('Button');
    buttonImportCell.style.paddingRight = "0";
    const buttonImport = document.createElement("button");
    buttonImport.setAttribute("id", "import-btn");
    buttonImport.setAttribute("type", "button");
    buttonImport.setAttribute("role", "button");
    buttonImport.setAttribute("title", "Import data from JSON or Florians tollige Zeiterfassung Excel");
    buttonImport.setAttribute("onclick", "");
    buttonImport.classList.add('BaseButton');
    buttonImport.classList.add('SectionButton');
    buttonImport.innerHTML = "<span>Import</span>"
    buttonImport.addEventListener("click", this.actionFtZExcelDialog.bind(this));
    buttonImportCell.appendChild(buttonImport);
  }

  private failedUpdate() {
    if (!this.buttonFailed) {
      return;
    }
    this.buttonFailed.disabled = sessionStorage.getItem("import_failed_summary") === null;
  }

  // show the import modal dialog
  private actionFtZExcelDialog() {
    this.ftzDialogEntry.value = '';
    this.ftzLookupRowRequested = false;
    this.resetFtZView();
    this.ftzDialog.style.display = 'flex';
    this.ftzDialogEntry.focus();
  }

  // close the import modal dialog
  private actionFtZExcelClose() {
    this.ftzDialog.style.display = 'none';
    this.ftzDialogEntry.value = '';
    this.resetFtZView();
  }

  // reset the FtZ dialog back to the paste view
  private resetFtZView() {
    this.ftzEntries = [];
    this.ftzOutsideEntries = [];
    this.ftzCorrectionInputs = new Map();
    this.ftzCorrectionContainer.innerHTML = '';
    this.ftzCorrectionContainer.style.display = 'none';
    this.ftzDialogEntry.style.display = '';
    this.ftzOkButton.innerHTML = "<span>Start Import</span>";
    this.ftzOkButton.disabled = false;
  }

  private runTasks() {
    const importer = Importer.getInstance();
    importer.runTasks().then(() => {
      this.failedUpdate();
    })
  }

  // start the import: JSON data goes to the JSON import, Excel data to the FtZ import
  private actionFtZExcelImport() {
    const inCorrectionView = this.ftzCorrectionContainer.style.display !== 'none';

    if (!inCorrectionView) {
      // phase 1: detect the pasted format and branch to the matching importer
      const text = this.ftzDialogEntry.value;
      const format = Timesheetimport.detectImportFormat(text);
      if (format === 'json') {
        if (!Configuration.getInstance().experimentalJsonImport()) {
          alert("Der JSON-Import ist in der Konfiguration deaktiviert.");
        } else if (this.importJson(text)) {
          this.actionFtZExcelClose();
        }
        return;
      }
      if (format === null) {
        alert("Unbekanntes Format. Bitte JSON-Daten oder die kompletten Excel-Daten aus Florians tollige Zeiterfassung (inkl. Tabellenkopf) einfügen.");
        return;
      }
      if (!Configuration.getInstance().experimentalFtZExcelImport()) {
        alert("Der Excel-Import (Florians tollige Zeiterfassung) ist in der Konfiguration deaktiviert.");
        return;
      }

      // parse the pasted tab-separated data
      this.ftzEntries = Timesheetimport.parseFtZTsv(text);

      // set aside bookings on weekdays that are not part of the current timesheet
      // (e.g. a week split by a month end), they cannot be imported
      const gridWeekdays = this.ftzGridWeekdays();
      if (gridWeekdays.size > 0) {
        const inGrid = (e: FtZEntry) => gridWeekdays.has(Timesheetimport.ftzWeekdayToken[e.weekday]);
        this.ftzOutsideEntries = this.ftzEntries.filter(e => !inGrid(e) && !Timesheetimport.isBreakEntry(e));
        this.ftzEntries = this.ftzEntries.filter(e => inGrid(e));
      }

      // on first pass: show the review view if anything needs attention (missing, invalid or outside the week)
      const missing = this.ftzEntries.filter(e => e.workOrder === '' && !Timesheetimport.isBreakEntry(e));
      const invalid = this.distinctInvalidWorkOrders();

      // the workorder lookup needs a time entry row in editing mode: open one (page reload),
      // the dialog is restored afterwards with suggestions
      if (invalid.length > 0 && !this.ftzLookupRowRequested && this.ftzLookupContext() === null) {
        this.requestFtZLookupRow();
        return;
      }

      if (missing.length > 0 || invalid.length > 0 || this.ftzOutsideEntries.length > 0) {
        this.renderFtZCorrections(invalid, missing);
        return;
      }
    } else {
      // phase 2: apply the user corrections to the stored entries
      this.ftzCorrectionInputs.forEach((input, original) => {
        const corrected = input.value.trim();
        // remember valid corrections so the field is prefilled next time
        if (corrected !== original && Timesheetimport.workOrderPattern.test(corrected)) {
          this.saveFtZCorrection(original, corrected);
        }
        this.ftzEntries.forEach(entry => {
          if (entry.workOrder === original) {
            entry.workOrder = corrected;
          }
        });
      });

      // invalid workorders block the import until fixed; missing ones are only a warning
      const invalid = this.distinctInvalidWorkOrders();
      if (invalid.length > 0) {
        const missing = this.ftzEntries.filter(e => e.workOrder === '' && !Timesheetimport.isBreakEntry(e));
        this.renderFtZCorrections(invalid, missing);
        return;
      }
    }

    // all invalid workorders resolved -> start the real import
    this.startFtZImport();
  }

  // open a time entry row for the workorder lookup. Unit4 reloads the page for that, so the pasted
  // text is kept in sessionStorage and restoreFtZDialog() reopens the dialog after the reload.
  private requestFtZLookupRow() {
    this.ftzLookupRowRequested = true;
    sessionStorage.setItem(Timesheetimport.ftzPendingDialogStorageKey, this.ftzDialogEntry.value);

    // prefer an existing workorder row, otherwise add an empty one (reused by the import later)
    const row = [...this.section.querySelectorAll('tr.ListItem, tr.AltListItem')]
      .find(r => r.querySelector('td[data-type="cell-workorder"]') && !Timesheetimport.isBreakRow(r));
    const cell = row?.querySelector('td[data-type=cell-description] div.ww.ellipsis') as HTMLElement | null;

    this.ftzDialogEntry.style.display = 'none';
    this.ftzCorrectionContainer.textContent = 'Workorder-Suche wird vorbereitet, Unit4 lädt kurz neu …';
    this.ftzCorrectionContainer.style.display = 'block';
    this.ftzOkButton.disabled = true;

    if (cell) {
      cell.click();
    } else {
      this.standardAddBtn.dispatchEvent(new Event('click'));
    }

    // Unit4 did not reload: continue without suggestions (unless the dialog was cancelled meanwhile)
    window.setTimeout(() => {
      sessionStorage.removeItem(Timesheetimport.ftzPendingDialogStorageKey);
      if (this.ftzDialog.style.display === 'none') {
        return;
      }
      this.resetFtZView();
      this.actionFtZExcelImport();
    }, 5000);
  }

  // reopen the FtZ dialog with the pasted text after the reload triggered by requestFtZLookupRow()
  private restoreFtZDialog() {
    const text = sessionStorage.getItem(Timesheetimport.ftzPendingDialogStorageKey);
    if (text === null) {
      return;
    }
    sessionStorage.removeItem(Timesheetimport.ftzPendingDialogStorageKey);
    if (Importer.getInstance().currentTask()) {
      return; // an import is running, do not interfere
    }
    this.actionFtZExcelDialog();
    this.ftzDialogEntry.value = text;
    this.ftzLookupRowRequested = true;
    this.actionFtZExcelImport();
  }

  // JSON starts with [ or {, the Excel export is recognized by its bookings (never valid JSON)
  private static detectImportFormat(text: string): 'json' | 'ftz' | null {
    const trimmed = text.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      return 'json';
    }
    return Timesheetimport.parseFtZTsv(text).length > 0 ? 'ftz' : null;
  }

  // load the saved column-F -> corrected workorder map from localStorage
  private loadFtZCorrections(): { [original: string]: string } {
    try {
      return JSON.parse(localStorage.getItem(Timesheetimport.ftzCorrectionStorageKey) ?? '{}');
    } catch {
      return {};
    }
  }

  // persist a single column-F -> corrected workorder mapping
  private saveFtZCorrection(original: string, corrected: string) {
    const map = this.loadFtZCorrections();
    map[original] = corrected;
    localStorage.setItem(Timesheetimport.ftzCorrectionStorageKey, JSON.stringify(map));
  }

  // build and run the import tasks from the parsed (and corrected) FtZ entries
  private startFtZImport() {
    const importer = Importer.getInstance();

    WOImportTask.setSection(this.section);
    WOImportTask.setAddButton(this.standardAddBtn);

    // group bookings by workorder + comment; sum the durations per weekday
    type FtZGroup = { wo: WorkOrder; hours: Map<string, number> };
    const groups = new Map<string, FtZGroup>();
    let sumHours = 0;

    // imported work hours per weekday, for the final sanity check
    const hoursByDay = new Map<string, number>();

    // earliest start / latest end per weekday for the working-hours (From/To) fields
    type FtZDay = { start: string; end: string };
    const workingDay = new Map<string, FtZDay>();

    // break hours per weekday, derived from the gaps between the day's bookings,
    // for the auto-inserted activity-999 row
    const breaksByDay = new Map<string, number>();
    let sumBreaks = 0;

    // all booking intervals (decimal hours) per weekday, used to compute the break gaps
    type Interval = { start: number; end: number };
    const dayIntervals = new Map<string, Interval[]>();

    this.ftzEntries.forEach(entry => {
      const token = Timesheetimport.ftzWeekdayToken[entry.weekday];
      if (!token) return; // unknown weekday

      // "Pause" marker rows carry no work time -> ignore them entirely
      if (Timesheetimport.isBreakEntry(entry)) return;

      const hours = Utils.hoursFromTimestring(entry.duration);
      if (isNaN(hours) || hours <= 0) return;

      // collect the booking interval (defines presence -> gaps between them are breaks) and
      // the working-hours window (min start / max end). Bookings without a workorder count
      // as well, so that window and breaks are derived from the same bookings.
      if (entry.start !== '' && entry.end !== '') {
        const list = dayIntervals.get(token) ?? [];
        list.push({ start: Utils.hoursFromTimestring(entry.start), end: Utils.hoursFromTimestring(entry.end) });
        dayIntervals.set(token, list);

        const day = workingDay.get(token);
        if (!day) {
          workingDay.set(token, { start: entry.start, end: entry.end });
        } else {
          if (Utils.hoursFromTimestring(entry.start) < Utils.hoursFromTimestring(day.start)) { day.start = entry.start; }
          if (Utils.hoursFromTimestring(entry.end) > Utils.hoursFromTimestring(day.end)) { day.end = entry.end; }
        }
      }

      if (entry.workOrder === '') return; // missing workorder -> already warned, cannot import

      const description = Configuration.getInstance().formatFtZDescription(entry);
      const key = entry.workOrder + '\u0000' + description;
      let group = groups.get(key);
      if (!group) {
        group = {
          wo: { workOrder: entry.workOrder, activity: '', timeCode: '', description },
          hours: new Map<string, number>()
        };
        groups.set(key, group);
      }
      group.hours.set(token, (group.hours.get(token) ?? 0) + hours);
      sumHours += hours;
      hoursByDay.set(token, (hoursByDay.get(token) ?? 0) + hours);
    });

    // derive the break per weekday as the sum of the gaps between consecutive bookings
    dayIntervals.forEach((intervals, token) => {
      intervals.sort((a, b) => a.start - b.start);
      let gap = 0;
      let prevEnd = intervals[0].end;
      for (let i = 1; i < intervals.length; i++) {
        if (intervals[i].start > prevEnd) { gap += intervals[i].start - prevEnd; }
        prevEnd = Math.max(prevEnd, intervals[i].end);
      }
      // round to full minutes to avoid floating point noise
      gap = Math.round(gap * 60) / 60;
      if (gap > 0) {
        breaksByDay.set(token, gap);
        sumBreaks += gap;
      }
    });

    if (groups.size === 0 && breaksByDay.size === 0) {
      alert("Keine importierbaren Zeitbuchungen vorhanden.");
      return;
    }

    importer.addTask(new CloseEditingModeTask());

    // import the working hours (From/To) from the Excel start/end times: the whole From row first,
    // then the whole To row, so that only switching between the rows reloads the page
    if (workingDay.size > 0) {
      const starts: { [weekday: string]: string } = {};
      const ends: { [weekday: string]: string } = {};
      workingDay.forEach((day, token) => {
        starts[token] = day.start;
        ends[token] = day.end;
      });
      importer.addTask(new WorkingRowImportTask('ftz-workinghours|start', "start", starts));
      importer.addTask(new WorkingRowImportTask('ftz-workinghours|end', "end", ends));
    }

    importer.addTask(new CloseEditingModeTask());

    groups.forEach((group, key) => {
      const groupId = ['ftz', key].join('|');
      importer.addTask(new FtZStartWorkOrderImportTask(groupId, group.wo));
      importer.addTask(new WorkOrderImportTask(groupId, group.wo));
      importer.addTask(new DescriptionImportTask(groupId, group.wo));
      importer.addTask(new RowHoursImportTask(groupId, group.wo, Object.fromEntries(group.hours)));
    });

    importer.addTask(new CloseEditingModeTask());

    // book the breaks into Unit4's automatically inserted activity-999 row
    if (breaksByDay.size > 0) {
      const breakGroupId = 'ftz-breaks';
      const breakWo: WorkOrder = { workOrder: '', activity: '999', timeCode: '', description: 'Internal - Break Time' };
      importer.addTask(new StartBreakRowImportTask(breakGroupId));
      importer.addTask(new RowHoursImportTask(breakGroupId, breakWo, Object.fromEntries(breaksByDay)));
      importer.addTask(new CloseEditingModeTask());
    }

    importer.addTask(new WorkOrderSummaryTask(sumHours + sumBreaks, sumBreaks));

    // same sanity check as the JSON import (break rules, max. working time per day, weekly totals),
    // keyed by weekday (e.g. "Mon") since the Excel carries no dates
    const daily: SanityDaily = {};
    workingDay.forEach((day, token) => {
      const label = token.charAt(0).toUpperCase() + token.slice(1);
      daily[label] = {
        hours: hoursByDay.get(token) ?? 0,
        breaks: breaksByDay.get(token) ?? 0,
        workingTime: Utils.difference(day.start, day.end)
      };
    });
    importer.addTask(new SanityCheckTask(daily));

    importer.clearFailed();
    this.actionFtZExcelClose();
    this.runTasks();
  }

  // weekday tokens (mon, tue, ...) of the day columns in the time entry grid
  private ftzGridWeekdays(): Set<string> {
    const tokens = new Set<string>();
    this.section.querySelectorAll('th[data-type=cell-weekday]').forEach(head => {
      const text = (head.textContent ?? '').replace(/[_.\s]/g, '').toLowerCase();
      tokens.add(text.slice(0, 3));
    });
    return tokens;
  }

  // a booking that represents a break (column G / Workorder input contains "Pause")
  private static isBreakEntry(entry: FtZEntry): boolean {
    return entry.workOrderInput.trim().toLowerCase() === 'pause';
  }

  // distinct workorders that are present but do not match the required format
  private distinctInvalidWorkOrders(): string[] {
    return [...new Set(
      this.ftzEntries
        .map(e => e.workOrder)
        .filter(wo => wo !== '' && !Timesheetimport.workOrderPattern.test(wo))
    )];
  }

  // parse the tab-separated "Florians tollige Zeiterfassung" export into day-log entries.
  //
  // The user can copy two variants out of Excel, both of which end up here:
  //  - "großes Format": the whole table as a real grid (many lines). It has a leading
  //    spacer column (A), a statistics header on top and the week-summary block to the
  //    right of the "U4" column.
  //  - "kleines Format": only the day-log sub-range, which Excel flattens onto a single
  //    line (all rows/columns joined by tabs, no newlines).
  //
  // Both variants contain the exact same "core block" of columns in the same order:
  //   Gesamt(Tag) | Wochentag | Anfang | Ende | Dauer | Echte Workorder | Workorder | Ticket | Kommentar | U4
  // A preparser (ftzCoreCells) reduces every variant to that core block, dropping the
  // spacer column, the statistics header and the week-summary block. The shared extractor
  // then reads the columns by their fixed offset inside the block.
  private static parseFtZTsv(text: string): FtZEntry[] {
    return Timesheetimport.ftzBookingsFromCells(Timesheetimport.ftzCoreCells(text));
  }

  // preparser: reduce either copy variant to a flat stream of the day-log core-block cells
  private static ftzCoreCells(text: string): string[] {
    const grid = text.split(/\r?\n/).map(line => line.split('\t').map(cell => cell.trim()));

    // the day-log header row carries the literal labels "Gesamt (Tag)" and "U4"
    const headerRow = grid.find(row => row.includes('Gesamt (Tag)') && row.includes('U4'));
    if (headerRow) {
      const startCol = headerRow.indexOf('Gesamt (Tag)');
      const endCol = headerRow.indexOf('U4');

      // "großes Format": header on its own line -> keep only the core columns of every
      // row, cutting off the leading spacer, the statistics header and the week-summary.
      // "kleines Format" flattens header AND data onto one line, so the header row itself
      // already contains bookings; in that case we keep the raw stream (there is no
      // week-summary to strip) and let the extractor scan it.
      if (endCol >= startCol && !Timesheetimport.rowHasBooking(headerRow)) {
        return grid.flatMap(row => row.slice(startCol, endCol + 1));
      }
    }

    return grid.flat();
  }

  // shared extractor: pick the bookings out of the core-block cell stream by column offset
  private static ftzBookingsFromCells(cells: string[]): FtZEntry[] {
    const entries: FtZEntry[] = [];
    let weekday = '';

    for (let i = 0; i < cells.length; i++) {
      // remember the merged "Wochentag" cell for the following bookings of that day
      if (Timesheetimport.ftzWeekdays.has(cells[i])) {
        weekday = cells[i];
        continue;
      }

      const [start, end, duration] = [cells[i], cells[i + 1], cells[i + 2]];
      if (!Timesheetimport.isFtZBooking(start, end, duration)) {
        continue;
      }

      // read the work columns by their fixed offset behind the Anfang/Ende/Dauer triplet:
      // +3 Echte Workorder, +4 Workorder, +5 Ticket, +6 Kommentar
      entries.push({
        weekday,
        start,
        end,
        duration,
        workOrder: cells[i + 3] ?? '',
        workOrderInput: cells[i + 4] ?? '',
        ticket: cells[i + 5] ?? '',
        comment: cells[i + 6] ?? '',
      });

      // skip the cells consumed by this booking so they are not re-scanned
      i += 6;
    }

    return entries;
  }

  // true if the row contains a valid Anfang/Ende/Dauer time-triplet anywhere
  private static rowHasBooking(row: string[]): boolean {
    for (let i = 0; i + 2 < row.length; i++) {
      if (Timesheetimport.isFtZBooking(row[i], row[i + 1], row[i + 2])) {
        return true;
      }
    }
    return false;
  }

  // a real booking is three HH:MM cells whose duration matches the Anfang->Ende span.
  // this rejects day totals, empty/zero rows and the week-summary block (which reuse HH:MM).
  private static isFtZBooking(start: string, end: string, duration: string): boolean {
    const re = Timesheetimport.ftzTimeRe;
    if (!re.test(start) || !re.test(end) || !re.test(duration)) {
      return false;
    }
    const span = Utils.difference(start, end);
    return span > 0 && Math.abs(span - Utils.hoursFromTimestring(duration)) <= 0.02;
  }

  // show the review view: non-blocking warnings for missing workorders and correction inputs for invalid ones
  private renderFtZCorrections(invalidWorkOrders: string[], missingEntries: FtZEntry[]) {
    this.ftzCorrectionInputs = new Map();
    this.ftzCorrectionContainer.innerHTML = '';

    // remembered corrections from previous imports (column F -> corrected workorder)
    const savedCorrections = this.loadFtZCorrections();

    // context for Unit4's workorder lookup, only available while a time entry row is in editing mode
    const lookupContext = invalidWorkOrders.length > 0 ? this.ftzLookupContext() : null;

    // warning block for bookings without any workorder (does not block the import)
    if (missingEntries.length > 0) {
      const warning = document.createElement("div");
      warning.classList.add("ftzCorrection__warning");

      const warningHeading = document.createElement("p");
      warningHeading.classList.add("ftzCorrection__heading");
      warningHeading.textContent = `⚠ ${missingEntries.length} Buchung(en) ohne Workorder. Im Normalfall ein Fehler – bitte in der Excel ergänzen und neu einfügen (blockiert den Import aber nicht):`;
      warning.appendChild(warningHeading);

      missingEntries.forEach(entry => {
        const line = document.createElement("div");
        line.classList.add("ftzCorrection__occurrence");
        line.textContent = Timesheetimport.formatOccurrence(entry);
        warning.appendChild(line);
      });

      this.ftzCorrectionContainer.appendChild(warning);
    }

    // warning block for bookings on days that are not part of the current timesheet (skipped)
    if (this.ftzOutsideEntries.length > 0) {
      const warning = document.createElement("div");
      warning.classList.add("ftzCorrection__warning");

      const warningHeading = document.createElement("p");
      warningHeading.classList.add("ftzCorrection__heading");
      warningHeading.textContent = `⚠ ${this.ftzOutsideEntries.length} Buchung(en) an Tagen, die es in diesem Timesheet nicht gibt. Diese werden nicht importiert:`;
      warning.appendChild(warningHeading);

      this.ftzOutsideEntries.forEach(entry => {
        const line = document.createElement("div");
        line.classList.add("ftzCorrection__occurrence");
        line.textContent = Timesheetimport.formatOccurrence(entry);
        warning.appendChild(line);
      });

      this.ftzCorrectionContainer.appendChild(warning);
    }

    // correction block: one input per distinct invalid workorder, with all its occurrences as context
    if (invalidWorkOrders.length > 0) {
      const heading = document.createElement("p");
      heading.classList.add("ftzCorrection__heading");
      heading.textContent = `${invalidWorkOrders.length} ungültige Workorder(s) gefunden. Bitte im Format 950100-10005 korrigieren:`;
      this.ftzCorrectionContainer.appendChild(heading);

      invalidWorkOrders.forEach(wo => {
        const group = document.createElement("div");
        group.classList.add("ftzCorrection__group");

        const row = document.createElement("div");
        row.classList.add("ftzCorrection__row");

        const label = document.createElement("span");
        label.classList.add("ftzCorrection__label");
        label.textContent = wo;
        row.appendChild(label);

        const input = document.createElement("input");
        input.setAttribute("type", "text");
        input.setAttribute("placeholder", "950100-10005");
        input.classList.add("ftzCorrection__input");
        input.value = savedCorrections[wo] ?? wo;
        row.appendChild(input);

        group.appendChild(row);

        // suggestions from Unit4's workorder lookup, e.g. all 950100-* workorders for "950100-X"
        if (lookupContext) {
          const suggestions = document.createElement("div");
          suggestions.classList.add("ftzCorrection__suggestions");
          group.appendChild(suggestions);
          this.bindFtZSuggestions(input, suggestions, lookupContext, Timesheetimport.ftzSearchTerm(wo));
        }

        // list every occurrence of this workorder so the user can identify it
        const occurrences = document.createElement("div");
        occurrences.classList.add("ftzCorrection__occurrences");
        this.ftzEntries
          .filter(e => e.workOrder === wo)
          .forEach(e => {
            const line = document.createElement("div");
            line.classList.add("ftzCorrection__occurrence");
            line.textContent = Timesheetimport.formatOccurrence(e);
            occurrences.appendChild(line);
          });
        group.appendChild(occurrences);

        this.ftzCorrectionInputs.set(wo, input);
        this.ftzCorrectionContainer.appendChild(group);
      });
    }

    // switch from paste view to review view
    this.ftzDialogEntry.style.display = 'none';
    this.ftzCorrectionContainer.style.display = 'block';
    this.ftzOkButton.innerHTML = invalidWorkOrders.length > 0
      ? "<span>Übernehmen &amp; Import</span>"
      : "<span>Trotzdem importieren</span>";
    const firstInput = this.ftzCorrectionContainer.querySelector('input') as HTMLInputElement | null;
    if (firstInput) { firstInput.focus(); }
  }

  // context for Unit4's workorder lookup service. It is bound to a time entry row in editing mode:
  // the grid context "TTS025^<instance>^TS1611^DE3^<section>" with the section replaced by
  // the workorder field id and the row number of the edit row.
  private ftzLookupContext(): string | null {
    const grid = this.section.querySelector('th[data-type="cell-workorder"]')?.closest('table[data-context]') as HTMLElement | null;
    const editRow = [...(grid?.querySelectorAll('tr.EditRow') ?? [])].find(row => !Timesheetimport.isBreakRow(row));
    const rowNr = editRow?.id.match(/_row(\d+)$/)?.[1];
    const fieldId = (editRow?.querySelector('td[data-type="cell-workorder"] [data-fieldid]') as HTMLElement | null)?.dataset.fieldid;
    if (!grid?.dataset.context || !rowNr || !fieldId) {
      return null;
    }
    try {
      const parts = atob(grid.dataset.context).split('^');
      return parts.length >= 5 ? btoa([...parts.slice(0, 4), fieldId, rowNr].join('^')) : null;
    } catch {
      return null;
    }
  }

  // the break row (activity 999) never offers workorders in the lookup
  private static isBreakRow(row: Element): boolean {
    const activity = row.querySelector('td[data-type="cell-activity"]');
    const value = (activity?.querySelector('input') as HTMLInputElement | null)?.value ?? activity?.textContent ?? '';
    return value.trim().startsWith('999');
  }

  // search term for the lookup: the leading digits of a workorder, e.g. "950100" for "950100-X"
  private static ftzSearchTerm(value: string): string {
    return (value.trim().match(/^[\d-]*/)?.[0] ?? '').replace(/-+$/, '');
  }

  // query Unit4's autocomplete service, the same request the workorder field sends while typing
  private static async lookupFtZWorkOrders(context: string, search: string): Promise<{ value: string, descr: string }[]> {
    try {
      const body = new URLSearchParams({ Search: search, Context: context, BatchStart: '1', BatchSize: '50' });
      const res = await fetch('System/Services/DataListService.aspx', { method: 'POST', body });
      if (!res.ok) {
        return [];
      }
      const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
      return [...xml.querySelectorAll('item')]
        .map(item => ({
          value: item.querySelector('value')?.textContent?.trim() ?? '',
          // descriptions are HTML-encoded twice, e.g. "f&amp;#246;rderung"
          descr: new DOMParser().parseFromString(item.querySelector('descr')?.textContent ?? '', 'text/html').body.textContent?.trim() ?? ''
        }))
        // drops the "[NEW]" entry that echoes the search term
        .filter(item => Timesheetimport.workOrderPattern.test(item.value));
    } catch (e) {
      console.warn('FtZ workorder lookup failed', e);
      return [];
    }
  }

  // fill the suggestion list of one correction input and search again while the user types
  private bindFtZSuggestions(input: HTMLInputElement, list: HTMLElement, context: string, initialSearch: string) {
    let timer: number | undefined;
    let requestId = 0;

    const search = async (term: string) => {
      const id = ++requestId;
      if (term === '') {
        list.textContent = '';
        return;
      }
      list.textContent = 'Suche …';
      const items = await Timesheetimport.lookupFtZWorkOrders(context, term);
      if (id !== requestId) {
        return; // a newer search has been started meanwhile
      }
      list.textContent = items.length === 0 ? 'Keine passenden Workorders gefunden' : '';
      items.forEach(item => {
        const option = document.createElement("button");
        option.setAttribute("type", "button");
        option.classList.add("ftzCorrection__suggestion");
        if (item.value === input.value.trim()) {
          option.classList.add("ftzCorrection__suggestion--selected");
        }

        const code = document.createElement("span");
        code.classList.add("ftzCorrection__suggestionCode");
        code.textContent = item.value;
        option.appendChild(code);

        const descr = document.createElement("span");
        descr.textContent = item.descr;
        option.appendChild(descr);

        option.addEventListener('click', () => {
          input.value = item.value;
          list.querySelectorAll('.ftzCorrection__suggestion--selected').forEach(e => e.classList.remove("ftzCorrection__suggestion--selected"));
          option.classList.add("ftzCorrection__suggestion--selected");
        });
        list.appendChild(option);
      });
    };

    // same delay as Unit4's own autocomplete
    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => search(Timesheetimport.ftzSearchTerm(input.value)), 400);
    });
    search(initialSearch);
  }

  // format a booking as "Wochentag Anfang–Ende · Kommentar" for the review lists
  private static formatOccurrence(entry: FtZEntry): string {
    const time = `${entry.start}–${entry.end}`;
    const context = [entry.weekday, time].filter(v => v !== '').join(' ');
    return entry.comment !== '' ? `${context} · ${entry.comment}` : context;
  }

  // import JSON data, returns false (after telling the user) if the data is not valid
  private importJson(text: string): boolean {
    try {
      const json = JSON.parse(text) as ImportFormat|ImportFormatOld;
      // check if we have old or new format
      var data: ImportWorkOrder[] = [];
      var days: ImportWorkingHours = {};

      if (json.hasOwnProperty('days') || json.hasOwnProperty('entries')) {
        // new format
        data = (json as ImportFormat).entries ?? [];
        days = (json as ImportFormat).days ?? {};
      } else {
        // old format
        data = json as ImportFormatOld;
        days = {};
      }

      /*
      New format (including working times):
      {
        "days": {
            "2026-04-27": {
                "start": "08:00",
                "end": "18:00"
            }
        },
        "entries": [
          {
            "workOrder": "400002-10027", "activity": "100", "description": "Import test #1",
            "time": [
              { "date": "2023-05-01", "hours": "1.5" },
              { "date": "2023-05-02", "hours": "0.75" }
            ]
          },
          {
            "workOrder": "400002-10025", "activity": "100", "description": "Import test #2",
            "time": [
              { "date": "2023-05-03", "hours": "1.25" },
              { "date": "2023-05-05", "hours": "4.75" }
            ]
          }
        ]
      }
      */

      const importer = Importer.getInstance();

      // import work orders
      WOImportTask.setSection(this.section);
      WOImportTask.setAddButton(this.standardAddBtn);

      const daily: SanityDaily = {};

      // close all editing modes before import (so that no edit row is still active)
      importer.addTask(new CloseEditingModeTask());

      // import working hours
      Object.entries(days).forEach(([dateStr, day]: [string, ImportWorkingHoursDay]) => {
        const date = new Date(dateStr);
        const groupId = ["workinghours", dateStr].join('|');
        importer.addTask(new WorkingStartImportTask(groupId, date, day.start));
        importer.addTask(new WorkingEndImportTask(groupId, date, day.end));
        // update daily working time for sanity check
        if (!daily[dateStr]) {
            daily[dateStr] = { hours: 0, breaks: 0, workingTime: 0 };
        }
        // calculate working time based on start and end time (format: HH:MM)
        daily[dateStr].workingTime = Utils.difference(day.start, day.end);
      });

      // close all editing modes after storing working hours
      importer.addTask(new CloseEditingModeTask());

      var sumHours = 0, sumBreaks = 0;
      data.forEach((entry: any) => {
        // group all tasks for the same work order together
        const groupId = ["workorders", entry.timeCode, entry.workOrder, entry.activity, entry.description].join('|');
        importer.addTask(new StartWorkOrderImportTask(groupId, entry));
        importer.addTask(new TimecodeImportTask(groupId, entry));
        importer.addTask(new WorkOrderImportTask(groupId, entry));
        importer.addTask(new ActivityImportTask(groupId, entry));
        importer.addTask(new DescriptionImportTask(groupId, entry));
        entry.time.forEach((timeEntry: any) => {
          const hours = Utils.toNumber(timeEntry.hours);
          importer.addTask(new HoursImportTask(groupId, entry, new Date(timeEntry.date), hours));
          // sum hours and breaks
          sumHours += hours;
          if (entry.timeCode === "99") {
            sumBreaks += hours;
          }
          // data for sanity check
          if (!daily[timeEntry.date]) {
              daily[timeEntry.date] = { hours: 0, breaks: 0, workingTime: 0 };
          }
          if (entry.timeCode === "99") {
              daily[timeEntry.date].breaks += hours;
          } else {
              daily[timeEntry.date].hours += hours;
          }
        });
      });

      // close all editing modes at the end
      importer.addTask(new CloseEditingModeTask());

      // check sum of hours
      importer.addTask(new WorkOrderSummaryTask(sumHours, sumBreaks));

      // General sanity check
      importer.addTask(new SanityCheckTask(daily));

      // handle first import item
      importer.clearFailed();
      importer.runTasks();
      return true;
    } catch (e) {
      console.error(e);
      alert("Import data must be valid JSON");
      return false;
    }
  }

}
