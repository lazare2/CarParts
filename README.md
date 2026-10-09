# CarParts (ავტონაწილები)

Stock, container and sales tracker for car parts imported in containers. Runs locally on Windows, keeps
everything in one database file, no internet needed.

- **ნაწილები** – what is in stock (good units only), per category, with how many came from each container;
  add parts to the basket and sell several at once
- **კონტეინერები** – each shipment with its total price (₾, or $ with the exchange rate). Parts are recorded
  per container, damaged units are kept apart (and can still be sold as damaged). Shows how much of the
  container price has come back and the profit
- **ხელოსნები** – repairmen who send customers: commission % per sold part, totals per month, payments made
  and what is still owed
- **ფინანსები** – per month: sales (as receipts), returns, commissions, containers bought, result; returns and
  cancelling a mistaken sale happen here
- **ადმინი** – part types, categories and their fields (brand, car, engine, ...)

Money can be entered in ₾ or $ (with the rate of the day); everything is shown in ₾.

## Install (desktop icon)

Two ways, both create an **ავტონაწილები** icon on the Desktop and in the Start menu. Clicking it opens the app
in its own window; closing the window stops it.

1. **`CarParts-Setup.exe`** – a single file, nothing else needed (Node.js is bundled). Download it from the
   [Releases](../../releases) page, or build it yourself (see below).
2. **`Install.bat`** – from a copy of this repository. Needs [Node.js](https://nodejs.org) 22.13+ installed once;
   `node.exe` is copied into the app. If a `data\carparts.db` exists in the repository folder it is taken over.

Windows may warn about an unknown publisher because the installer is not code-signed – choose *More info → Run anyway*.
No admin rights are needed. To remove the app use *Settings → Apps* (your data is kept).

## Where is my data?

| What | Where |
| --- | --- |
| Database | `%APPDATA%\CarParts\data\carparts.db` |
| Daily backups (last 14) | `%APPDATA%\CarParts\backups\` |
| Logs (if something goes wrong) | `%APPDATA%\CarParts\logs\` |

The program and the data are separate: closing the app, restarting the PC, reinstalling, updating or uninstalling
never deletes the database. To move to another PC, copy `carparts.db` into the same folder there.

## Run without installing (developers)

```
start.bat          # or: npm start  ->  http://localhost:3000, data in .\data\carparts.db
npm run seed       # fill an empty database with fake demo data
```

Requires Node.js 22.13+ (uses the built-in `node:sqlite`, no `npm install` needed).

## Build the installer

```
powershell -ExecutionPolicy Bypass -File installer\build-setup.ps1
```

produces `dist\CarParts-Setup.exe` (bundles the `node.exe` of the machine that builds it). To publish it:
GitHub → *Releases → Draft a new release* → attach the file.
