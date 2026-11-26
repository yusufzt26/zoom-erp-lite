# ZT-Tally-Sync (accounts PC)

Small Windows program for the PC where Tally runs. Every 5 minutes it **reads** from Tally's XML port (default `http://localhost:9000`)
and sends to ZT-ERP LITE (`/api/tally/push`):

- party ledgers under Sundry Debtors and Sundry Creditors (balance, GSTIN, bill-wise on/off)
- unpaid bills from Tally's Bills Receivable and Bills Payable reports
- receipts and payments of the last 90 days

Every request to Tally is an Export. The program never imports, alters or deletes anything in Tally.

## How it runs

- Double-click: a console window does the one-time setup (checks Tally, asks for the setup code made in ZT-ERP LITE > Tally sync > Setup,
  copies itself to `%LOCALAPPDATA%\ZT-Tally-Sync`, adds the Windows task "ZT Tally Sync" every 5 minutes, adds a Start menu shortcut, sends the first data).
  Opened again later, it shows the last sync and offers Sync now / new setup code / log / remove.
- `ZT-Tally-Sync.exe --once`: one quiet sync (what the task runs; no window).
- `ZT-Tally-Sync.exe --uninstall`: removes the task, shortcut and settings.
- The sync key is stored encrypted with Windows DPAPI (only that Windows user on that PC can read it). The ERP keeps only a hash of it.
- If Tally is closed or a company is not open, the ERP is told (it keeps the last data and shows the problem on the Tally sync page).

## Build

```
go test ./...
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -H windowsgui" -o ZT-Tally-Sync.exe .
```

Needs Windows 10 or 11 (64-bit). The exe is not code-signed, so Windows SmartScreen asks once ("More info" > "Run anyway").
