# CoolGroove Event Platform - Repository Ecosystem Diagram

## Architecture Overview

```
+-----------------------------------------------------------------------------------+
|                        COOLGROOVE EVENT PLATFORM ECOSYSTEM                         |
|                    "End-to-end event management for Sao Paulo"                     |
+-----------------------------------------------------------------------------------+

                              +-------------------+
                              |    DOLIBARR ERP    |
                              |  (Shared Backend)  |
                              |  ---------------   |
                              |  Contacts / CRM    |
                              |  Invoices / Billing |
                              |  Products / Stock   |
                              |  Projects / Tasks   |
                              |  Third-parties      |
                              +--------+----------+
                                       |
                    +------------------+------------------+
                    |                  |                   |
                    v                  v                   v
+-------------------+--+  +-----------+---------+  +------+----------------+
|                      |  |                     |  |                       |
|   SISTEMAV2          |  |   TEATROMARS        |  |   CARNAVAL            |
|   (Operations Hub)   |  |   (Venue Booking)   |  |   (Engagement App)   |
|                      |  |                     |  |                       |
+---+------------------+  +----------+----------+  +------+----------------+
    |                                |                     |
    |     +-------------------+      |                     |
    +---->| STAGEMASTER-AI    |<-----+                     |
          | (Show Automation) |                            |
          +-------------------+                            |
                                                           |
          +-------------------+                            |
          | CLAUDE (Prototypes|<------ Market Research ---->+
          | & Visualizations) |    (ticketing & audience)
          +-------------------+


============================================================================
                         DETAILED REPOSITORY MAP
============================================================================


1. SISTEMAV2 - "CoolGroove Sistema v2" (Operations Hub)
=========================================================

   Role: Central operations dashboard for the venue
   Tech: React 19 + TypeScript + Vite | Node.js + Express backend
   Port: Frontend dev server | Backend API server

   +------------------------------------------------------------------+
   |                        SISTEMAV2                                  |
   |                                                                   |
   |  +------------------+  +------------------+  +----------------+  |
   |  | CentroVibe       |  | Banking Module   |  | WhatsApp       |  |
   |  | Event Manager    |  | (Inter, Itau)    |  | Integration    |  |
   |  | - Calendar views |  | - PIX / Boleto   |  | - 2-way chat   |  |
   |  | - Artist mgmt    |  | - Reconciliation |  | - Broadcasting |  |
   |  | - 6 music clusters| | - Webhooks      |  | - Doc delivery |  |
   |  | - Ticket tracking|  | - Approval queue |  |                |  |
   |  +------------------+  +------------------+  +----------------+  |
   |                                                                   |
   |  +------------------+  +------------------+  +----------------+  |
   |  | Competitor Intel  |  | CRM / Contacts   |  | Email Service  |  |
   |  | - Sympla scraper |  | - 120+ contacts  |  | - IMAP/SMTP    |  |
   |  | - Shotgun scraper|  | - Task tracking  |  | - Parsing      |  |
   |  | - Blacktag scraper| | - Projects       |  | - Scheduler    |  |
   |  | - AI classify    |  | - Interventions  |  |                |  |
   |  +------------------+  +------------------+  +----------------+  |
   |                                                                   |
   |  +------------------+  +------------------+  +----------------+  |
   |  | Dashboard & KPIs |  | Invoicing        |  | Inventory      |  |
   |  | - Real-time stats|  | - Expense reports|  | - Stock mgmt   |  |
   |  | - Audit logging  |  | - Multi-bank     |  | - Categories   |  |
   |  +------------------+  +------------------+  +----------------+  |
   |                                                                   |
   |  Integrations: Dolibarr API | Banco Inter | Banco Itau           |
   |                Gemini/Claude AI | Cloudflare Tunnel               |
   +------------------------------------------------------------------+

   Data Flow:
   - Scrapes Sympla/Shotgun/Blacktag every 6 hours for competitor events
   - AI classifies events into 6 music clusters
   - Manages venue spaces: Green Area (250 pax) + Main Hall (650 pax)
   - Banking operations + financial reconciliation
   - WhatsApp for customer communication


2. TEATROMARS - "Teatro Mars" (Venue Booking & Quotation)
=========================================================

   Role: Client-facing event booking and budget calculator
   Tech: PHP 7.4+ (vanilla) | HTML5 + Vanilla JS + Tailwind CSS

   +------------------------------------------------------------------+
   |                        TEATROMARS                                 |
   |                                                                   |
   |  +------------------+  +------------------+  +----------------+  |
   |  | Budget Calculator|  | Marciano Chatbot |  | Quote System   |  |
   |  | - Spaces         |  | (via n8n + GPT-4)|  | - Shareable    |  |
   |  | - Catering       |  | - WhatsApp bot   |  |   links        |  |
   |  | - Equipment (80+)|  | - AI-driven      |  | - Access track |  |
   |  | - Entertainment  |  |   quotes         |  | - Auto-save    |  |
   |  | - Infrastructure |  | - Pre-fills web  |  | - Base64/short |  |
   |  | - Staffing       |  |   interface      |  |   URL params   |  |
   |  | - Decorations    |  |                  |  |                |  |
   |  +------------------+  +------------------+  +----------------+  |
   |                                                                   |
   |  +------------------+  +------------------+  +----------------+  |
   |  | Event Scenarios  |  | Lead Management  |  | Admin Panel    |  |
   |  | - Essential pkg  |  | - Auto-create    |  | - Dashboard    |  |
   |  | - Intermediate   |  |   Dolibarr leads |  | - Image upload |  |
   |  | - Premium pkg    |  | - Field mapping  |  | - Backups      |  |
   |  | - Thematic pkg   |  | - CRM integration|  |                |  |
   |  +------------------+  +------------------+  +----------------+  |
   |                                                                   |
   |  Venue Spaces: Hall (250 pax) | Main Stage (600 pax)             |
   |  Integrations: Dolibarr API | n8n | OpenAI GPT-4                 |
   |                Microsoft Clarity | Google Analytics               |
   +------------------------------------------------------------------+

   Data Flow:
   - Marciano chatbot (WhatsApp) -> fetches catalog -> generates quote link
   - Client opens link -> personalized budget calculator
   - Client customizes -> submits -> auto-creates Dolibarr CRM lead
   - Supports 7 event categories with real-time price calculation


3. CARNAVAL - "Carnaval Engagement App" (Attendee Experience)
==============================================================

   Role: Attendee-facing gamification and engagement platform
   Tech: React 19 + TypeScript + Vite | Dolibarr PHP module | Node.js WebSocket

   +------------------------------------------------------------------+
   |                        CARNAVAL                                   |
   |                                                                   |
   |  +------------------+  +------------------+  +----------------+  |
   |  | Jukebox          |  | Battle Royale    |  | Gamification   |  |
   |  | - Song voting    |  | - Genre brackets |  | - XP & Levels  |  |
   |  | - Genre veto     |  | - QF > SF > Final|  | - Missions     |  |
   |  | - Real-time rank |  | - Live voting    |  | - Titles/Badges|  |
   |  | - Stats          |  | - WebSocket sync |  | - Streaks      |  |
   |  +------------------+  +------------------+  +----------------+  |
   |                                                                   |
   |  +------------------+  +------------------+  +----------------+  |
   |  | Social / Match   |  | Ticketing        |  | Store Economy  |  |
   |  | - Like/skip      |  | - Ticket batches |  | - PartyCoins   |  |
   |  | - Music profiles |  | - PIX payments   |  | - Coin packages|  |
   |  | - Online status  |  | - QR check-in    |  | - Merchandise  |  |
   |  | - In-person verify| | - Invoices       |  | - VIP upgrades |  |
   |  +------------------+  +------------------+  +----------------+  |
   |                                                                   |
   |  +------------------+  +------------------+  +----------------+  |
   |  | Multiplayer Games|  | Producer Panel   |  | Staff Tools    |  |
   |  | - Matchmaking    |  | - Event phases   |  | - QR scanner   |  |
   |  | - Duo formation  |  | - Batch mgmt     |  | - Redemption   |  |
   |  | - Game history   |  | - Tournament ctrl|  | - Metrics      |  |
   |  | - Leaderboards   |  | - Staff roles    |  |                |  |
   |  +------------------+  +------------------+  +----------------+  |
   |                                                                   |
   |  Event Phases: VOTING > LOCKED > LIVE > BATTLE > FINISHED        |
   |  Integrations: Dolibarr API | Banco Inter (PIX) | Socket.IO      |
   +------------------------------------------------------------------+

   Data Flow:
   - Attendees buy tickets (PIX) -> check in via QR
   - During event: vote on music, complete missions, play games, earn XP
   - Social matching connects attendees by music taste
   - Battle Royale tournament eliminates genres via live votes
   - Economy: earn/buy PartyCoins -> redeem for drinks/merch


4. STAGEMASTER-AI - "StageMaster AI" (Show Production Automation)
==================================================================

   Role: AI-powered technical production control for live shows
   Tech: React 19 + TypeScript + Vite | Node.js + Express + Socket.IO

   +------------------------------------------------------------------+
   |                     STAGEMASTER-AI                                |
   |                                                                   |
   |  +------------------+  +------------------+  +----------------+  |
   |  | AI Script Parser |  | Cue Management   |  | Live Controls  |  |
   |  | - Gemini AI      |  | - Light cues     |  | - GO / PREV    |  |
   |  | - Local parser   |  | - Sound cues     |  | - Timeline     |  |
   |  | - Scene detection|  | - Video cues     |  | - Follow trig  |  |
   |  | - Auto cue gen   |  | - Mic control    |  | - Panic/blackout|  |
   |  +------------------+  +------------------+  +----------------+  |
   |                                                                   |
   |  +------------------+  +------------------+  +----------------+  |
   |  | Lighting Control |  | Sound Control    |  | Video/Media    |  |
   |  | - DMX patching   |  | - OSC protocol   |  | - OBS control  |  |
   |  | - ArtNet driver  |  | - X32 mixer      |  | - Multi-screen |  |
   |  | - Lumikit MIDI   |  | - Channel mgmt   |  | - Media server |  |
   |  | - Fixture profiles| | - DCA groups     |  | - Projectors   |  |
   |  | - Light scenes   |  | - Audio playback |  | - Asset mgmt   |  |
   |  +------------------+  +------------------+  +----------------+  |
   |                                                                   |
   |  +------------------+  +------------------+                      |
   |  | Multi-User Roles |  | Project Manager  |                      |
   |  | - Director       |  | - Save/load shows|                      |
   |  | - Light Operator |  | - Media uploads  |                      |
   |  | - Sound Operator |  | - Import/export  |                      |
   |  | - Video Operator |  | - Storage monitor|                      |
   |  | - Media Server   |  |                  |                      |
   |  +------------------+  +------------------+                      |
   |                                                                   |
   |  Protocols: ArtNet (DMX) | OSC | MIDI | OBS WebSocket            |
   |  Hardware: Behringer X32 | Lumikit | LED Panels | Projectors     |
   +------------------------------------------------------------------+

   Data Flow:
   - Import script (Portuguese theater format)
   - AI parses scenes -> generates cue list (light, sound, video)
   - Director triggers cues in LIVE mode via GO button
   - WebSocket syncs all operator stations in real-time
   - Controls physical hardware: lights (DMX), sound (X32), video (OBS)


5. CLAUDE - "Prototypes & Visualizations"
==========================================

   Role: Experimental prototypes and visual tools
   Tech: HTML5 + Three.js (3D)

   +------------------------------------------------------------------+
   |                        CLAUDE                                     |
   |                                                                   |
   |  +------------------+                                             |
   |  | arquibancada.html|  3D interactive bleacher/grandstand          |
   |  | - Three.js 3D    |  visualization for venue seating layout     |
   |  | - Seat mapping   |                                             |
   |  | - Color zones    |  Prototype for seat selection / venue        |
   |  | - Interactive    |  capacity planning                          |
   |  +------------------+                                             |
   |                                                                   |
   |  Market Research Files (workspace-level):                         |
   |  - brazil-ticketing-market-research.md                            |
   |  - brazil_events_freelancer_market_research.md                    |
   +------------------------------------------------------------------+


============================================================================
                     INTER-REPOSITORY RELATIONSHIPS
============================================================================

  +------------------------------------------------------------------+
  |                                                                    |
  |  SHARED INTEGRATION LAYER: DOLIBARR ERP                           |
  |  ============================================                      |
  |                                                                    |
  |  sistemav2 -----> Dolibarr API (100+ endpoints)                   |
  |                   - Full CRM, invoicing, inventory                |
  |                   - Banking reconciliation                         |
  |                   - Event/project management                       |
  |                                                                    |
  |  TeatroMars ----> Dolibarr API (lead creation)                    |
  |                   - Auto-creates CRM leads from quotes            |
  |                   - Custom field mapping                           |
  |                                                                    |
  |  carnaval ------> Dolibarr API (custom module)                    |
  |                   - User management via thirdparties              |
  |                   - Invoicing for ticket purchases                 |
  |                   - Product catalog for store items                |
  |                                                                    |
  +------------------------------------------------------------------+

  +------------------------------------------------------------------+
  |                                                                    |
  |  VENUE WORKFLOW (End-to-End)                                       |
  |  ============================================                      |
  |                                                                    |
  |  1. PLAN        sistemav2 monitors market + plans events           |
  |                 (competitor scraping, AI classification,            |
  |                  artist booking, calendar management)               |
  |                                                                    |
  |  2. SELL        TeatroMars generates quotes for private events     |
  |                 carnaval sells tickets for public events            |
  |                 (PIX payments, batch pricing, QR tickets)           |
  |                                                                    |
  |  3. ENGAGE      carnaval drives pre/during/post-event engagement   |
  |                 (missions, voting, battles, social matching,        |
  |                  gamification, in-app economy)                      |
  |                                                                    |
  |  4. PRODUCE     stagemaster-ai automates show production            |
  |                 (AI cue generation, lighting/sound/video control,   |
  |                  multi-operator real-time coordination)             |
  |                                                                    |
  |  5. OPERATE     sistemav2 handles back-office operations           |
  |                 (banking, invoicing, WhatsApp comms, CRM,           |
  |                  inventory, expense tracking)                       |
  |                                                                    |
  |  6. PROTOTYPE   claude repo for experimental features              |
  |                 (3D venue visualization, market research)           |
  |                                                                    |
  +------------------------------------------------------------------+

  +------------------------------------------------------------------+
  |                                                                    |
  |  SHARED TECHNOLOGY PATTERNS                                        |
  |  ============================================                      |
  |                                                                    |
  |  Frontend:  React 19 + TypeScript + Vite + Tailwind CSS           |
  |             (sistemav2, carnaval, stagemaster-ai)                  |
  |                                                                    |
  |  Real-time: Socket.IO WebSockets                                   |
  |             (sistemav2, carnaval, stagemaster-ai)                  |
  |                                                                    |
  |  AI:        Gemini / Claude / GPT-4                                |
  |             (sistemav2: event classification,                      |
  |              stagemaster-ai: script parsing,                       |
  |              TeatroMars: chatbot quotes)                           |
  |                                                                    |
  |  Payments:  Banco Inter PIX API                                    |
  |             (sistemav2: banking ops, carnaval: ticket payments)    |
  |                                                                    |
  |  Backend:   Dolibarr ERP (PHP)                                     |
  |             (sistemav2, TeatroMars, carnaval)                      |
  |                                                                    |
  +------------------------------------------------------------------+


============================================================================
                         DEPENDENCY GRAPH
============================================================================

                          Dolibarr ERP
                         /     |      \
                        /      |       \
                       v       v        v
                sistemav2  TeatroMars  carnaval
                   |                      |
                   |     Banco Inter      |
                   +--------(PIX)--------+
                   |
                   v
              stagemaster-ai          claude
              (show production)    (prototypes)


============================================================================
                      TEAM / AUDIENCE MATRIX
============================================================================

  +----------------+--------------------+---------------------------+
  | Repository     | Primary Users      | Purpose                   |
  +----------------+--------------------+---------------------------+
  | sistemav2      | Venue operators,   | Back-office operations,   |
  |                | managers, admins   | event planning, finance   |
  +----------------+--------------------+---------------------------+
  | TeatroMars     | Clients, sales     | Venue booking, quotes,    |
  |                | team, chatbot      | lead generation           |
  +----------------+--------------------+---------------------------+
  | carnaval       | Event attendees,   | Engagement, gamification, |
  |                | producers, staff   | ticketing, social         |
  +----------------+--------------------+---------------------------+
  | stagemaster-ai | Show directors,    | Production automation,    |
  |                | tech operators     | lighting/sound/video      |
  +----------------+--------------------+---------------------------+
  | claude         | Developers         | Prototypes, research,     |
  |                |                    | experimental features     |
  +----------------+--------------------+---------------------------+
