# Excel import ("Florians tollige Zeiterfassung")

Notice: this is currently an experimental feature, you need to explicitly activate it
in the configuration ("Import data from Florians tollige Zeiterfassung Excel").

The import takes the day log of the "Florians tollige Zeiterfassung" Excel and enters
work orders, descriptions, hours, working hours (From/To) and breaks into your Unit4
timesheet.

# How to use

## 1. Copy the data from Excel

Click anywhere into the time entry area of the Excel and press **Ctrl+A**: Excel selects
all your time entries. Copy them with **Ctrl+C**.

Don't worry about selecting too much: pressing Ctrl+A a second time (or clicking into the
header and pressing Ctrl+A) selects the whole sheet, including the statistics and the week
summary. That works just as well, the import picks out the time entries in both cases.

## 2. Paste and import

1. Open your timesheet in Unit4 and click **Import** below the time entry table.
2. Paste the data into the dialog (Ctrl+V) and click **Start Import**.

The same button also accepts JSON data (see [JSON-Import.md](JSON-Import.md)),
the format is detected automatically.

## 3. Review (only if needed)

If something needs your attention, a review view is shown before the import starts:

* **Bookings without a work order** are listed as a warning. They cannot be imported,
  usually you want to fix them in the Excel and paste again. The import can be started
  anyway.
* **Bookings on days that are not part of the current timesheet** (e.g. a week split by the
  end of a month) are listed and skipped.
* **Incomplete or invalid work orders** (e.g. `950100-X` or `950100`) have to be corrected
  before the import can start. Below each of them, the matching work orders from Unit4 are
  suggested with their description (e.g. all `950100-*` work orders) - just click the right
  one, or type to search again. To be able to search, Unit4 needs a time entry row in
  editing mode, so the page reloads once and the dialog opens again by itself.
  Your corrections are remembered and prefilled the next time.

## 4. Check and save

Since Unit4 reloads the page for many changes, the import takes a moment - a progress
indicator is shown in the top right corner. When it has finished, a summary is shown;
the **failed** button next to "Add" shows the last failures again.

The import does not save anything: check the result and hit **Save** when you are fine
with it.

# What gets imported

* **Work orders and descriptions**: the column "Echte Workorder" is used. Bookings with the
  same work order and description are combined into one row, the hours are summed up per
  day.
* **Working hours (From/To)**: the earliest start and the latest end of each day.
* **Breaks**: the gaps between the bookings of a day, entered into the break row
  (activity 999) that Unit4 inserts automatically. Rows marked as "Pause" in the Excel are
  ignored, as the gap already covers them.
* After the import, a sanity check verifies the break rules, the maximum working time per
  day and the weekly totals against the "Normal hours" of your timesheet.

# Descriptions

By default, the description is `<Ticket> <Comment>`, or just the comment if there is no
ticket. You can change this with the configuration option "FtZ description rules": a JSON
array of `{regex, template}` rules, the first rule whose regex matches the ticket wins.

Available placeholders: `{{Weekday}}`, `{{Start}}`, `{{End}}`, `{{Duration}}`,
`{{WorkOrder}}`, `{{WorkOrderInput}}`, `{{Ticket}}`, `{{Comment}}`.

Example: use only the comment for internal tickets, ticket and comment otherwise:

```
[
    { "regex": "^INT-", "template": "{{Comment}}" },
    { "regex": ".+", "template": "{{Ticket}} {{Comment}}" }
]
```

Please keep the descriptions short, long texts are hard to read for everybody
processing the timesheets afterwards.

# Importing again

You can import the same week again, e.g. after correcting the Excel: rows that already
exist (same work order and description) are updated instead of added a second time, and
hours that moved to another day are cleared.

If you changed the **work order or description** of a booking, the import cannot know that
it is the same booking: it adds a new row and the old one keeps its hours. The summary
then reports that the sum of hours does not match - delete the outdated row in that case.
