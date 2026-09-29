import { trans } from "../../global/trans";
import { ImportTask, ImportTaskResult, setValueWithoutRequest } from "./importtask";

export type WorkingHours = {
  date: string;
  start: string;
  end: string;
}

type FoundCell = {
    cell?: HTMLElement;
    input?: HTMLInputElement;
}
export abstract class WHImportTask extends ImportTask {

    public static createTask(taskData: any) {
        switch (taskData.task) {
            case 'WorkingStartImportTask':
                return new WorkingStartImportTask(taskData.groupId, new Date(taskData.date), taskData.value);
            case 'WorkingEndImportTask':
                return new WorkingEndImportTask(taskData.groupId, new Date(taskData.date), taskData.value);
            case 'FtZWorkingRowImportTask':
                return new FtZWorkingRowImportTask(taskData.groupId, taskData.type, taskData.times);
        }
    }

    constructor(groupId: string, public date: Date, public type: "start" | "end", public value: string) {
        super(groupId);
    }

    protected async lookupCell(): Promise<FoundCell> {
      const headers = await this.waitForElements('.tmWorkinghours th');
      const rows = await this.waitForElements('.workinghours-section .ListItem, .workinghours-section .AltListItem, .workinghours-section .EditRow');
      const date = new Date(this.date);
      const dateEN = (date.getMonth()+1) + "/" + date.getDate(); // eEN format: M/D

      const month = String(date.getMonth()+1).padStart(2, '0');
      const dateDE = date.getDate() + "." + month; // DE format: DD.MM.

      for(var i=0 ; i<headers.length ; ++i) {
        const head = headers[i] as HTMLElement;
        if (head.title.includes(dateEN) || head.title.includes(dateDE)) {
          for(var j=0 ; j<rows.length ; ++j) {
            const cell = rows[j].querySelector('td:nth-of-type(' + (i+1) + ')') as HTMLElement;
            const input = cell?.querySelector('.InputCell input') as HTMLInputElement;
            if (j === 0 && this.type === "start") {
                return { cell, input };
            } else if (j === 1 && this.type === "end") {
                return { cell, input };
            }
          }
        }
      }
      return {};
    }

    // format time string based on naviogator.language (e.g. AM/PM format)
    protected formatLocalTime(timeString: string, field: HTMLInputElement): string {
        // Parse the time string (assuming HH:MM or H:MM format)
        const [hours, minutes] = timeString.split(':').map(str => parseInt(str, 10));
        // create date object with the time
        const date = new Date();
        date.setHours(hours, minutes);
        // Format the time based on the user's locale
        return new Intl.DateTimeFormat(navigator.language, { hour: "numeric", minute: "numeric" }).format(date);
    }


    public async run(): Promise<ImportTaskResult> {
        const cell = await this.lookupCell();
        if (cell.input) {
            // fill value
            cell.input.focus();
            cell.input.value = this.formatLocalTime(this.value, cell.input);
            // Unit4 only marks the field as modified (setDirty) in its onchange handler,
            // which is not triggered by setting the value programmatically
            cell.input.dispatchEvent(new Event('change', { bubbles: true }));
            cell.input.blur();
            return this.next();
        } else if (cell.cell) {
            // click to activate and try again
            cell.cell.click();
            return this.retryAfterReload();
        }
        return this.failure(trans('error_date_cell_not_found', this.date.toLocaleDateString()));
    }

}

export class WorkingStartImportTask extends WHImportTask {
    constructor(groupId: string, day: Date, time: string) {
        super(groupId, day, "start", time);
    }

    actionDescription(): string {
        return "Enter working time (From) for " + this.date.toLocaleDateString();
    }
}
export class WorkingEndImportTask extends WHImportTask {
    constructor(groupId: string, day: Date, time: string) {
        super(groupId, day, "end", time);
    }

    actionDescription(): string {
        return "Enter working time (To) for " + this.date.toLocaleDateString();
    }
}

// FtZ variant: fills the whole From (or To) row at once, matching the day columns by their weekday
// token instead of a date. Only activating the row reloads the page; the values are sent with the
// next request (activating the other row or closing the editing mode).
export class FtZWorkingRowImportTask extends WHImportTask {
    // English weekday token as used in the grid headers (mon, tue, ...) -> time (HH:MM)
    public times: { [weekday: string]: string };
    constructor(groupId: string, type: "start" | "end", times: { [weekday: string]: string }) {
        super(groupId, new Date(0), type, '');
        this.times = times;
    }

    actionDescription(): string {
        return "Enter working time (" + (this.type === "start" ? "From" : "To") + ") for " + Object.keys(this.times).join(', ');
    }

    public async run(): Promise<ImportTaskResult> {
      const headers = await this.waitForElements('.tmWorkinghours th');
      const rows = await this.waitForElements('.workinghours-section .ListItem, .workinghours-section .AltListItem, .workinghours-section .EditRow');
      // first row: From, second row: To
      const row = rows[this.type === "start" ? 0 : 1];

      const cells: { [weekday: string]: HTMLElement } = {};
      for (var i=0 ; i<headers.length ; ++i) {
        const text = (headers[i].textContent ?? '').replace(/[_.\s]/g, '').toLowerCase();
        const weekday = Object.keys(this.times).find(w => text.startsWith(w));
        const cell = row?.querySelector('td:nth-of-type(' + (i+1) + ')') as HTMLElement | null;
        if (weekday && cell) {
          cells[weekday] = cell;
        }
      }
      const missing = Object.keys(this.times).filter(w => !cells[w]);
      if (missing.length === Object.keys(this.times).length) {
        return this.failure(trans('error_date_cell_not_found', missing.join(', ')));
      }

      const first = Object.values(cells)[0];
      if (!first.querySelector('.InputCell input')) {
        // row is not editable yet: click to activate and try again
        first.click();
        return this.retryAfterReload();
      }

      Object.entries(cells).forEach(([weekday, cell]) => {
        const input = cell.querySelector('.InputCell input') as HTMLInputElement | null;
        if (input) {
          setValueWithoutRequest(input, this.formatLocalTime(this.times[weekday], input));
        }
      });
      return missing.length > 0 ? this.failure(trans('error_date_cell_not_found', missing.join(', '))) : this.next();
    }
}
