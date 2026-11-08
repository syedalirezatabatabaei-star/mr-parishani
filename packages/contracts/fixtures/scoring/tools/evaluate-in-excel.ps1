# Runs every golden case through the client's own workbook in Microsoft Excel (task 3-1):
# the inputs of a case are typed into the form, Excel recalculates, and each output cell's
# value is read back. Nothing here computes a score; the workbook does.
#
#   powershell -NoProfile -File tools/evaluate-in-excel.ps1
#
# Reads tools/cases.json, writes tools/excel-results.json. The workbook is copied to a
# temporary file and opened read-only; the original in docs/source is never touched.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..\..\..\..')
$source = Get-ChildItem (Join-Path $root 'docs\source') -Filter '*.xlsx' | Select-Object -First 1
if ($null -eq $source) { throw 'the scoring workbook is not in docs/source' }
$copy = Join-Path ([IO.Path]::GetTempPath()) ('sepehr-scoring-' + [Guid]::NewGuid() + '.xlsx')
Copy-Item $source.FullName $copy

$spec = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'cases.json') | ConvertFrom-Json

# The form's input and output cells (sheet «فرم ارزیابی»).
$inputCells = [ordered]@{
  borrower   = [ordered]@{ job = 'C10'; tenure = 'C11'; coverage = 'C12'; obligations = 'C13' }
  guarantor1 = [ordered]@{ job = 'H10'; tenure = 'H11'; coverage = 'H12'; debts = 'H13'; independence = 'H14' }
  guarantor2 = [ordered]@{ job = 'M10'; tenure = 'M11'; coverage = 'M12'; debts = 'M13'; independence = 'M14' }
}
$outputCells = @(
  'E7', 'D10', 'D11', 'D12', 'D13', 'B17', 'B18', 'D17', 'D18',
  'I10', 'I11', 'I12', 'I13', 'I14', 'G17', 'G18', 'G19', 'O17',
  'N10', 'N11', 'N12', 'N13', 'N14', 'L17', 'L18', 'L19', 'O18',
  'B19', 'B23', 'B24', 'B25', 'B26', 'B27'
)
$clear = 'B7,H7,B32,C10:C13,H10:H14,M10:M14'

$excel = New-Object -ComObject Excel.Application
try {
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.AutomationSecurity = 3 # no macros (the workbook has none)
  $book = $excel.Workbooks.Open($copy, 0, $true)
  # By position: «فرم ارزیابی», «جداول پایه», «راهنما و قواعد» (this file stays ASCII, as
  # Windows PowerShell reads a script without a byte-order mark in the ANSI code page).
  if ($book.Worksheets.Count -ne 3) { throw 'the workbook no longer has its three sheets' }
  $form = $book.Worksheets.Item(1)
  $base = $book.Worksheets.Item(2)

  $labels = [ordered]@{}
  $scores = [ordered]@{}
  foreach ($who in $spec.options.PSObject.Properties) {
    foreach ($criterion in $who.Value.PSObject.Properties) {
      foreach ($option in $criterion.Value) {
        $labels[$option.cell] = [string]$base.Range($option.cell).Value2
        $scores[$option.cell] = $base.Range($option.cell).Offset(0, 1).Value2
      }
    }
  }
  $formulas = [ordered]@{}
  foreach ($cell in $outputCells) { $formulas[$cell] = [string]$form.Range($cell).Formula }
  $validations = [ordered]@{}
  foreach ($cell in @('C10', 'C11', 'C12', 'C13', 'H10', 'H11', 'H12', 'H13', 'H14', 'M14', 'B32')) {
    $validations[$cell] = [string]$form.Range($cell).Validation.Formula1
  }

  $optionCell = @{}
  foreach ($who in $spec.options.PSObject.Properties) {
    $side = if ($who.Name -eq 'borrower') { 'borrower' } else { 'guarantor' }
    foreach ($criterion in $who.Value.PSObject.Properties) {
      foreach ($option in $criterion.Value) {
        $optionCell["$side.$($criterion.Name).$($option.code)"] = $option.cell
      }
    }
  }

  $results = [ordered]@{}
  foreach ($case in $spec.cases) {
    $form.Range($clear).ClearContents() | Out-Null
    $in = $case.inputs
    if ($null -ne $in.amountToman) { $form.Range('B7').Value2 = [double]$in.amountToman }
    if ($null -ne $in.approvedToman) { $form.Range('H7').Value2 = [double]$in.approvedToman }
    if ($null -ne $in.guarantorsShareIncome) { $form.Range('B32').Value2 = [string]$in.guarantorsShareIncome }
    foreach ($party in $inputCells.Keys) {
      $answers = $in.$party
      if ($null -eq $answers) { continue }
      $side = if ($party -eq 'borrower') { 'borrower' } else { 'guarantor' }
      foreach ($criterion in $answers.PSObject.Properties) {
        $cell = $optionCell["$side.$($criterion.Name).$($criterion.Value)"]
        if ($null -eq $cell) { throw "unknown option $side.$($criterion.Name).$($criterion.Value) in $($case.id)" }
        $form.Range($inputCells[$party][$criterion.Name]).Value2 = $labels[$cell]
      }
    }
    $excel.CalculateFull()
    $out = [ordered]@{}
    foreach ($cell in $outputCells) {
      $text = $form.Range($cell).Text
      if ($text -like '#*') { throw "Excel error $text in $cell of $($case.id)" }
      $out[$cell] = $form.Range($cell).Value2
    }
    $results[$case.id] = $out
  }
  $book.Close($false)

  $report = [ordered]@{
    workbook    = $source.Name
    excel       = $excel.Version
    labels      = $labels
    scores      = $scores
    formulas    = $formulas
    validations = $validations
    results     = $results
  }
  $json = $report | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText((Join-Path $here 'excel-results.json'), $json, (New-Object Text.UTF8Encoding $false))
  Write-Output "evaluated $($spec.cases.Count) cases in Excel $($excel.Version)"
}
finally {
  $excel.Quit()
  [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
  Remove-Item $copy -ErrorAction SilentlyContinue
}
