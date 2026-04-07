

# Home Health Scheduler App

## Overview
A document-driven scheduling app for home health workers that optimizes visit routes for minimal travel time. All data stored locally as JSON files — no backend needed. Works as an installable PWA.

## Core Data & Setup

### Worker Profile
- Home address, name, working hours
- Personal availability constraints (e.g., no Fridays, lunch break 12-1)

### Client Management
- Add/edit/remove clients via forms
- Each client: name, address, visit duration, frequency (weekly/biweekly/monthly), priority level
- Per-client time windows (e.g., Mon 9-12, Wed 2-5)

### Travel Time Matrix
- Editable grid where the worker enters estimated drive times between their home and each client, and between clients
- Smart defaults (e.g., 15 min) with easy override

## Scheduling Engine (Client-Side)

### Optimization Algorithm
- Nearest-neighbor heuristic with improvements — runs entirely in the browser
- Inputs: client constraints, travel times, visit durations, worker availability
- Optimizes for: lowest total travel time → shortest time away from home
- Respects all time windows and frequency requirements

### Schedule Output
- **Daily view**: Ordered list of visits with start times, travel time between stops, and total time away from home
- **Weekly view**: Full week calendar grid showing all scheduled visits
- **Route map**: Visual map of the day's route using Leaflet (free, no API key) with numbered stops and lines connecting them — addresses geocoded via free Nominatim API

## File Management

### Local Document Storage
- Save/load workspace as a single JSON file containing all clients, worker profile, travel times, and generated schedules
- Export/import for manual sync via Google Drive, iCloud, Dropbox, etc.
- Auto-save to browser storage (IndexedDB) so data persists between sessions

## PWA Support
- Installable from browser to home screen
- Works offline after first load
- Service worker caches app shell; all data is local

## UI Pages
1. **Dashboard** — Quick overview: today's schedule, next client, total travel time
2. **Clients** — List/add/edit clients with constraints
3. **Travel Times** — Matrix editor for drive times between locations
4. **Schedule** — Generate & view daily/weekly optimized schedule + route map
5. **Settings** — Worker profile, home address, working hours, file import/export

