# Fleetify — Rekabet Ortamı & Pazar Analizi

> **Rekabet istihbaratı briefing'i** · 25 Temmuz 2026
> Yöntem: 5 paralel araştırma akışı · ~70+ ürün · kaynak-atıflı, güven-etiketli (Y=yüksek / O=orta / D=düşük).
> Analist TAM'leri yönseldir. İnteraktif sürüm (grafik + konumlandırma haritası): https://claude.ai/code/artifact/20557ec4-64cd-4581-a74b-d42bb5a14acb

---

## Verdict — tek bakışta

**Kategori kalabalık — ama Fleetify'ın durduğu köşe boş kaldı.** "AI kodlama agent'larını tek yerden yönet" fikri 2025 ortasında patladı ve şimdiden konsolide oluyor: 40+ yerel orkestratör, dört büyük labın "command center"ı, $26–60B'lık bulut devleri. Yine de **yerel çalışan + satıcı-nötr + çok-CLI-agent + provider-üstü maliyet** bileşimini iyi-fonlanmış tek bir oyuncu bile sunmuyor.

1. **Fleetify gerçek ama dar bir farkla ayrışıyor.** Rakiplerin ~20'si sadece CLI agent'ların üstüne bir kabuk ve o agent'ların auth'unu miras alıyor. Fleetify hem 10 CLI agent'ı hem 11 ham HTTP provider'ı tek yerel kokpitte birleştiriyor; üstüne çapraz-agent marketplace + @mention fleet dispatch + Auto model-router + tam git/PR hattı. Bu bileşime en yakın tek rakip **Coder/Mux** — o da çok daha az provider'la.
2. **Para ve momentum ezici çoğunlukla bulut-hosted otonomide** (Cognition/Devin $26B, Cursor ~$29B→$60B beklemede, Factory $1.5B; dört lab da async bulut agent'ı çıkardı). Ama Fleetify'ın işgal ettiği katman — satıcı-nötr "kontrol düzlemi / mission control" — iki yönden sıkıştırılıyor: yukarıdan **GitHub Agent HQ**, aşağıdan yerel orkestratörler.
3. **En öğretici tek veri:** Fleetify'ın konseptine en yakın *hosted* analog — **Terragon/Terry** (Claude Code/Codex CLI'larını bulutta orkestre eden servis) — Şubat 2026'da çekiş yetersizliğinden **kapandı**. Aynı işi yapan *yerel* araçlar yaşıyor → local-first bahsi sağlam.
4. **Asıl risk özellik değil, dağıtım.** "Multi-model" ve giderek "MCP + marketplace" artık masaya giriş bedeli. Fleetify'ın savunulabilir konumu incumbent'ların iş modeli gereği gidemeyeceği yer: **yerel, özel, satıcı-nötr, agent-agnostik + provider-üstü maliyet görünürlüğü.** Ama Fleetify şu an yıldız liderlik tablosunda **hiç yok** — kazananın-çoğu-aldığı bir zihin-payı yarışında en büyük tehlike.

**Tek bakışta çıpalar:**

| Metrik | Değer |
|---|---|
| AI kodlama-aracı pazarı (2025 → 2030) | ~$3–5B → ~$25–30B (~%25–27 CAGR) |
| AI aracı kullanan geliştirici | %84–85 — ama güven düşüyor (%40 → %29) |
| Doğrudan rakip (yerel çoklu-agent orkestratörü) | ~40+ |
| Fleetify'ın kamuya açık çekişi | **0★** |

---

## 01 · Fleetify & yöntem

**Fleetify nedir.** Çapraz-platform (Rust + Tauri v2) bir masaüstü kokpit. Birçok heterojen AI kodlama agent'ını (Claude Code, Codex CLI, Kimi, OpenCode, Cursor CLI, Copilot CLI, Grok Build, Hermes, Antigravity) tek satıcı-nötr GUI'den paralel çalıştırır; üstüne 11 HTTP provider (OpenAI, Anthropic, DeepSeek, xAI, NVIDIA NIM, Kimi, Gemini, Perplexity, OpenRouter, Cloudflare, Ollama). Katmanlar: maliyet takibi, git/PR hattı, MCP, plugin marketplace (`~/.claude` · `~/.gemini` · `~/.codex`'e materialize), Auto model-router, bellek, çok-agent dispatch, workflow motoru. **Local-first**; anahtarlar OS keychain'de; agent auth'unu tutmaz, tespit eder. ACP + MCP konuşur.

**Yöntem.** 5 paralel araştırma akışı (yerel orkestratörler · bulut/async platformlar · IDE'ler · çoklu-provider istemciler · pazar/fon/trend); ~70+ ürün; GitHub yıldızları canlı API'den (25 Tem 2026); fiyat/fon zaman-damgalı ve güven-etiketli; doğrulanamayanlar açıkça işaretli. **Karar odağı örtük** (konumlandırma / farklılaştırma / GTM).

---

## 02 · Pazar görünümü

Büyük ve hızlı büyüyen iki pazarın kesişimindeki hızlı büyüyen bir niş — "$50B TAM'e sahibiz" değil.

| Çıpa | Değer | Kaynak | Güven |
|---|---|---|---|
| Kurumsal AI kodlama-agent pazarı (yıllıklandırılmış) | ~$9.8–11B | Gartner, Nis 2026 | Y |
| Geniş "AI agents" pazarı CAGR | %40–47 → ~$42–53B (2030) | MarketsandMarkets / MarkNtel | O |
| OpenRouter hacmi | 25T token/hafta (6 ayda 5×) | Sacra / TechCrunch | Y |
| Tek-ürün gelirleri | Cursor ~$2B ARR + Claude Code ~$2.5B koşu | ikincil | O |

### Boyutlandırma — aralık, nokta değil

| Kaynak | Tanım | Bugün | İleri | CAGR |
|---|---|---|---|---|
| Gartner | AI kodlama-agent (kurumsal) | ~$9.8–11B | — | — |
| Grand View | AI code tools | $4.9B ('23) | $26.0B ('30) | 27.1% |
| Astute | AI coding assistant | $4.2B ('25) | $40.7B ('35) | 25.3% |
| SNS Insider | AI code assistant | $4.7B ('25) | $19.4B ('35) | 15.3% |
| MarketsandMarkets | Kodlama-agent segmenti | — | — | 52.4% |

**Savunulabilir başlık:** ~$3–5B (2025) → ~$25–30B (2030), ~%25–27 CAGR. Analist TAM'leri *yumuşak* — Cursor + Claude Code tek başına neredeyse tüm "2025 pazarı" kadar gelir üretiyor; çerçeveler gerçeği geriden takip ediyor.

### Fleetify için bottoms-up SAM → SOM

| Katman | Varsayım | Rakam |
|---|---|---|
| Profesyonel geliştirici | SlashData 2025 | 36.5M |
| …AI kodlama aracı kullanan | %84–85 | ~30M |
| …agentic **CLI** kullanan (autocomplete değil) | agentic diliminin ~%15–30'u | 4.5–9M |
| …**çoklu** agent/provider yöneten power-user — **SOM** | dilimin ~%3–8'i | **150–700K** |
| İllüstratif yıllık gelir SOM'u | çoğu ücretsiz/OSS; %5–15 dönüşüm × ~$60/yıl | **~$0.3–4.5M** |

SOM **dolar olarak küçük** (düşük tek haneli $M) ama **kullanıcı olarak gerçek** (~100–700K) ve alandaki *en hızlı büyüyen davranış*. Bahis: kohort büyürken satıcı-nötr kokpit olmak.

---

## 03 · Rakip haritası

Dört halka: doğrudan (yerel orkestratörler) · komşu-bulut · komşu-IDE · ikame.

### Halka A · Doğrudan — yerel çoklu-agent kokpitleri

GUI/TUI, çoğu git-worktree tabanlı. **En doğrudan rakip kümesi.**

| Ürün | Yapımcı | Platform | Agent | Fiyat / lisans | ★ (25 Tem 26) | Fleetify farkı |
|---|---|---|---|---|---:|---|
| **Orca** | Stably AI · YC | Masaüstü + iOS/Android + VPS | 25+ CLI | Ücretsiz · MIT | 28,728 | MCP + maliyet var; **HTTP-provider katmanı yok.** En ciddi tehdit |
| **Vibe Kanban** | Bloop AI · YC | Yerel web (kanban) | 10 CLI | Ücretsiz · Apache (bulut kapandı) | 27,505 | En güçlü kanban UX; provider/maliyet yok, momentum soğuyor |
| **cmux** | Manaflow | Native macOS | Her terminal agent | Ücretsiz · GPL | 25,113 | Terminal multiplexer; macOS-only, provider yok |
| **Superset** | superset-sh | Masaüstü (macOS) | Claude/Codex/OpenCode | Ücretsiz · Elastic 2.0 | 12,598 | 27-araçlı MCP + BYO key; saf OSS değil |
| **HumanLayer → CodeLayer** | YC F24 | Masaüstü + web + bulut | Claude 1st · Codex/Copilot | Free / $100·kullanıcı-ay | 11,160 | Kurumsal + onay akışı; provider/marketplace yok |
| **Agent Orchestrator** | AgentWrapper | Masaüstü agent IDE | ~23 harness | Ücretsiz · Apache | 8,565 | Geniş harness; provider/maliyet yok |
| **Claude Squad** | smtg-ai | TUI (tmux) | Claude/Codex/OpenCode/Amp | Ücretsiz · AGPL | 8,179 | Terminal saflığı; provider/PR/marketplace yok |
| **Backlog.md** | MrLesk | CLI + kanban | Claude/Gemini/Codex (MCP) | Ücretsiz · MIT | 6,288 | Görev/kanban katmanı, **yürütücü değil** |
| **Emdash** | General Action · YC W26 | Masaüstü | 25+ CLI | Ücretsiz · OSS | 5,269 | "Lock-in yok" + issue-senk; provider yok |
| **Container Use** | Dagger (S. Hykes) | CLI · MCP sunucusu | Claude/Cursor/Goose | Ücretsiz · Apache | 3,921 | Container izolasyonu (Fleetify'da eksik); UI/provider yok |
| **Crystal → Nimbalyst** | Stravu | Electron + iOS | Claude/Codex/OpenCode | Ücretsiz · MIT | 1,323 | Extension marketplace + görsel workspace; CLI-only |
| **Omnara** | YC S25 | Terminal + web + iOS | Claude/Codex/n8n | Free · $9/ay | 2,653 | Telefondan izle/onayla; izolasyon yok |
| **Mux** | Coder | Masaüstü + tarayıcı | Kendi harness'ı + Ollama/OpenRouter | Ücretsiz · AGPL | 1,934 | **En yakın mimari analog** — ham-model + maliyet + MCP; az provider, dispatch yok |
| **CCManager** | kbwo | TUI | 8 CLI | Ücretsiz · MIT | 1,202 | Geniş CLI kapsamı ama çıplak oturum-değiştirici |
| **Conductor** | Melty Labs · YC S24 | **macOS-only** · kapalı | Claude/Codex (+Cursor) | Ücretsiz (BYO) | n/a | Diff/PR/@mention iyi; 2 agent, provider/maliyet yok |
| **Sculptor** | Imbue | Masaüstü (Mac/Linux) | Claude (+Codex) | Ücretsiz (beta) | 207 | Container-per-agent izolasyon; dar agent/provider |

**Ayrıca:** ruflo/claude-flow **65,895★** (başsız swarm meta-harness — farklı paradigma) · **Elenmeler:** Terragon kapandı, Vibe Kanban bulutu kapandı, Crystal→Nimbalyst'e dönüştü, Uzi uykuda.

**GitHub yıldızları (zihin-payı yarışı — ve Fleetify'ın tabloda olmayışı):**

```
Orca          ████████████████████████████  28,728
Vibe Kanban   ███████████████████████████   27,505
cmux          ████████████████████████      25,113
Superset      ████████████                  12,598
HumanLayer    ██████████                    11,160
Claude Squad  ████████                       8,179
Emdash        █████                          5,269
Omnara        ██                             2,653
Mux (Coder)   █                              1,934
CCManager     █                              1,202
Fleetify      ·                                  0  ← kamuya kapalı
```
*Hariç: ruflo 65.9k (farklı paradigma) · Backlog.md (görev katmanı). Bu bir **dağıtım** açığı, ürün açığı değil.*

### Halka B · Komşu-bulut — bulut/async otonom platformlar

Sen görev verirsin, onların bulutunda koşar.

| Ürün | Şirket | Hosted? | Çok-model? | Mission-control? | Fiyat | Fon / değerleme | Güven |
|---|---|---|---|---|---|---|---|
| **Devin** | Cognition | Bulut | Evet (Pro) | Evet — paralel oturumlar | $20 / $200 | $26B (May 26) | Y |
| **Factory (Droids)** | Factory.ai | Bulut + yerel | Evet | Evet — "Software Factory" | $20 / $200 | $1.5B (Nis 26) | Y |
| **Codex (cloud)** | OpenAI | Bulut + CLI | Hayır (OpenAI) | Evet — "command center" | ChatGPT içinde | — | — |
| **Claude Code web** | Anthropic | Bulut + CLI | Hayır (Claude) | Evet — paralel işler | Claude planı | — | — |
| **Jules** | Google | Bulut | Hayır (Gemini) | Kısmi (3/15/60) | Free / $20 / $250 | — | — |
| **Copilot Agent HQ** | GitHub/Microsoft | Bulut | **Evet + 3. taraf** | **Evet — "Mission Control"** | $10 / $39 | — · 20M+ kul. | O |
| **Amp** | Sourcegraph | Bulut orbs + CLI | Soyutlanmış | Evet — subagent | Kredi + reklam-destekli | ~$2.6B ('21, bayat) | D |
| **Cursor Cloud Agents** | Anysphere | Bulut + IDE | Evet + Composer | Evet — Cursor 2.0 | $20 / $200 | ~$29.3B | O |
| **Augment (Remote Agents)** | Augment Code | Bulut/VPC/yerel | Evet (Prism) | Evet — "Cosmos" | $100/ay | $977M (Nis 24) | Y |
| **Tembo** | Tembo | Bulut + self-host | Evet | Evet — çok-repo | $60 / $200 | ~$14–21M | O |
| **Terry** | Terragon Labs | Bulut | Evet | Evet — paralel sandbox | — | **Şub 26 kapandı** | Y |

**Konsolidasyon hızlı:** Nvidia → Solver · ClickUp → Codegen · Cognition → Windsurf · Terragon kapandı · Vibe Kanban bulutu kapandı — hepsi ~12 ayda. Bağımsız orkestrasyon katmanı hyperscaler/unicorn'lara çekiliyor.

### Halka C · Komşu-IDE — agent-öncelikli editörler

Kodu *yazdığın* yer; artık kendi orkestrasyonunu içine çekiyor.

| Editör | Yapımcı | Çok-agent özelliği | Çok-model / BYO? | Fiyat | Değerleme / çekiş |
|---|---|---|---|---|---|
| **Cursor** | Anysphere → SpaceX | Cloud Agents — "istediğin kadar" paralel | Evet + Composer | $20 / $200 | $29.3B → $60B beklemede · $2B ARR |
| **Windsurf → Devin Desktop** | Cognition | Agent Command Center — **her ACP agent'ını host eder** | Evet | $20 / $200 | Cognition $10.2B |
| **Zed** | Zed Industries | **ACP host** — Claude/Gemini/Codex/Copilot/OpenCode | Evet (BYO-agent + BYOK) | $0 / $10 / $30 | $32M B · ~87.5k★ |
| **VS Code + Copilot** | Microsoft | **Agent HQ** — paralel çok-satıcılı mission control | Evet + BYOK | $10 / $39 / $100 | 20M+ kullanıcı |
| **Antigravity** | Google DeepMind | Manager — "mission control", ~5 paralel | Gemini 3 + Claude + GPT-OSS | Preview'da ücretsiz | Google · güvenlik olayları |
| **Kiro** | AWS | Spec-driven + subagent (~4–10) | Bedrock-kilitli (GPT/Gemini yok) | $20 → $200 | 100k+ waitlist |
| **Trae** | ByteDance | SOLO (tek-agent) · 20 eşzaman. bulut görev | Evet (BYOK yok) · telemetri sorunu | $3 → $100 | 1.6M MAU |
| **JetBrains Air + Junie** | JetBrains | **Air** — izole worktree'lerde harici CLI orkestre (ACP) | Evet + BYOK + ACP | $100–300/yıl | Büyük IDE tabanı |
| **Cline** | Cline Inc. | "Multi-agent teams" — koordinatör → uzmanlar | Tam BYO | OSS + BYO | $32M · ~65k★ |
| **Roo / Kilo Code** | Cline fork'ları | Orchestrator / "Boomerang" — izole alt-görevler | Çok-provider BYO | OSS + BYO | $5M / $8M · 24–26k★ |

Hepsi "multi-model" ama **tek-kontrol-düzlemi** — her biri *senin yaşadığın platform* olmak istiyor. Hiçbiri bir poliglotun zaten çalıştırdığı heterojen CLI'ları satıcı-nötr + yerel + provider-üstü maliyetle bir araya getirmiyor. **JetBrains Air** bu modele en yakın tehdit. **ACP çift taraflı:** Fleetify'ı kazanan standarda hizalıyor ama her editörün de multi-agent host'a dönüşmesini kolaylaştırıyor.

### Halka D · İkame — çoklu-provider chat istemcileri

"Tek uygulamada çok provider" ama kodlama CLI'ı orkestre etmez.

| Uygulama | Tip | Agentic / MCP? | Fiyat | ★ (25 Tem 26) |
|---|---|---|---|---:|
| **Open WebUI** | Self-host web · source-available | MCP (MCPO) + kod-sandbox — **CLI orkestrasyonu yok** | Ücretsiz | 146,683 |
| **NextChat** | Masaüstü (Tauri) · MIT | MCP (flag) + plugin | Ücretsiz | 88,545 |
| **Lobe Chat** | Masaüstü/web · source-avail. | MCP + "agent groups" (persona) | Free + Cloud | 80,791 |
| **AnythingLLM** | Masaüstü + Docker · MIT | RAG-agent + MCP + Flows | Free · $50/$99 | 63,824 |
| **Cherry Studio** | Masaüstü · AGPL | MCP + MCP marketplace | Free + Ent | 48,973 |
| **Jan** | Masaüstü (Tauri) · Apache | MCP + yerel API | Ücretsiz | 43,701 |
| **LibreChat** | Self-host web · MIT (ClickHouse) | Agents + MCP + kod-interpreter | Ücretsiz | 41,264 |
| **Chatbox** | Masaüstü + mobil · GPL | Agent Mode (Pro) + MCP | Free · $4–40/ay | 41,133 |
| **LM Studio** | Yerel model runtime · proprietary | MCP host — Fleetify bunu **tüketir** | Ücretsiz | n/a |
| **OpenRouter** | API aggregator | 400+ model / 70+ provider — orkestratör değil | %5.5 kredi ücreti | $1.3B · 8M kul. |

18 üründen 15'i artık MCP destekliyor → "MCP + marketplace" farkı zamanla erir. Ama hiçbiri kodlama CLI'ı orkestre etmiyor veya paralel otonom agent koşturmuyor — Fleetify'ın çekirdeği bu halkada **rakipsiz**. En iyi çerçeve: **OpenRouter bir ortak/provider, rakip değil** (Fleetify zaten entegre).

---

## 04 · Konumlandırma matrisi

İki eksen kararı belirliyor: **yürütme nerede** (yerel ↔ bulut) ve **ne kadar nötr/geniş** (tek-yığın ↔ satıcı-nötr çok-agent).

```
     SATICI-NÖTR · ÇOK-AGENT ▲
                             │
  ◍ BEYAZ ALAN               │
  ┌───────────────────┐      │
  │ Fleetify ●        │ JetBrains Air ○   GitHub Agent HQ ○
  │   Mux ○   Orca ○  │   Zed ○
  │                   │
  ├───────────────────┘
  │ Claude Squad ·         Cursor ○
  │ Conductor ·      Antigravity ○
  │                        Devin ○
  │                   Codex cloud · Claude Code web ·
  ◀── YEREL / KENDİ MAKİNEN ───────────── BULUT-HOSTED ──▶
                             │
        TEK-YIĞIN / KİLİTLİ  ▼
```

**Sol-üst köşe (yerel + satıcı-nötr) iyi-fonlanmış oyuncular tarafından işgal edilmemiş.** Fleetify'ın tek gerçek komşuları **Mux** ve **Orca** — ikisi de Fleetify'ın provider genişliğinden (11 HTTP) ve marketplace/dispatch bileşiminden yoksun. Agent HQ nötr ama *bulutta*. Cursor/Devin/Codex/Claude bulut + giderek kendi-modeline kayıyor. Conductor/Claude Squad yerel ama CLI-only/dar. Bu, "multi-model" veya "MCP" üzerinden değil **eksenlerin bileşimi** üzerinden savunulabilir bir konum: incumbent'lar iş modeli gereği sağ tarafta (bulut, kilit) kalmak zorunda.

---

## 05 · Trendler & katalizörler

1. **"Fleet / paralel agent" gerçek ve yükseliyor.** Her büyük lab bir "command center" çıkardı (OpenAI Codex app, Claude Code Agent View, Cursor 2, Antigravity Agent Teams). Üretim kanıtı: Stripe haftada 1.000+ agent-yazımı PR; Ramp'te merge'lerin ~%30'u agent'lardan.
2. **MCP + ACP + A2A standartlaşması — tezin tek en önemli kaldıracı.** MCP (Anthropic, Kas 2024) + ACP (Zed, Ağu 2025; JetBrains ortak) + A2A (Google→Linux Foundation). Nötr host'un artık bespoke entegrasyona ihtiyacı yok. *Çift taraflı:* aynı standart her editörün de multi-agent host'a dönüşmesini kolaylaştırıyor.
3. **"Multi-model" masaya giriş bedeli.** OpenRouter 25T tok/hafta, $1.3B — "tek model kazanmıyor" kanıtı. Ama Cursor, Factory, Augment, Agent HQ hepsi çok-model yönlendiriyor → **çok-model tek başına hendek değil.**
4. **Benimseme doygun, güven düşük.** Geliştiricilerin %84–85'i AI kullanıyor ama doğruluğa güven %40→%29 düştü → **kontrol/gözetim** satan ürünlere açık kapı.
5. **"Agent control plane" bir kategori oldu.** Forrester ilan etti (Ara 2025); a16z 2026 tezi "fleets of agents". Ama söylem kurumsal/bulut-kodlu — Fleetify'ın *yerel/kişisel* şeridi büyük ölçüde boş.
6. **Maliyet metrelemesi acı veriyor.** Her hosted rakip metreler: ACU (Devin), token (Factory/Augment), kredi (Amp/Tembo), premium request (Copilot). Fleetify'ın "kendi aboneliğini kullan, işini metrelemyiz" mesajı zamanlama olarak güçlü.

---

## 06 · Fırsatlar & tehditler

### Fırsatlar / beyaz alan
- **Sol-üst köşe boş:** yerel + satıcı-nötr + çok-CLI + BYO-login bileşimini fonlanmış hiçbir oyuncu sunmuyor.
- **Çok-provider maliyet/bütçe yönetimi** — CLI-only araçların yapısal olarak yapamayacağı, CFO-dostu hendek. Rakiplerin çoğunda maliyet takibi *yok*.
- **macOS-only kör noktası:** liderlerin çoğu (Conductor, cmux, Sculptor) sadece Mac. Windows-öncelikli/çapraz-platform boşta — Rust+Tauri tam buraya oturuyor.
- **Lisans temizliği:** rakiplerde source-available tepkisi var (Open WebUI branding, Lobe Chat). Gerçekten izin-verici lisans bir koz.
- **ACP-native host** — kazanan açık standarda hizalı; her ACP agent'ını sarabilir.

### Tehditler
- **GitHub Agent HQ** — en doğrudan stratejik tehdit: hosted, çok-satıcılı "Mission Control", Microsoft dağıtımı + GitHub iş akışı. Fleetify'ın tam tezi.
- **JetBrains Air** — izole worktree'lerde harici CLI orkestre eden, ACP'li, en yakın yerel-nötr incumbent.
- **IDE'ler orkestrasyonu içine çekiyor** — ACP "ayrı kokpite ihtiyacın var" argümanını aşındırıyor.
- **Orca & Mux** genişlik + maliyette yaklaşıyor; Orca mobil/VPS ekliyor.
- **Dağıtım açığı** — Fleetify yıldız tablosunda yok; rakipler ayda binlerce topluyor. **Asıl varoluşsal risk.**
- **Bakım koşu bandı** — 10 hızlı-değişen CLI'ı sarmak sürekli bakım yükü.

---

## 07 · Öneriler

| # | Öneri | Öncelik | Etki | Gerekçe / metrik |
|---|---|---|---|---|
| 1 | **Dağıtımı çöz** — OSS'e aç, güçlü Show HN / Product Hunt lansmanı, yıldız tablosuna gir | ŞİMDİ | Yüksek | Ürün rekabetçi, görünürlük değil. Metrik: ★ + haftalık aktif kurulum |
| 2 | **Kopyalanamayan kama ile lidership al** — "yerel + satıcı-nötr + çok-CLI + kendi login'in + provider-üstü maliyet" | ŞİMDİ | Yüksek | "Multi-model"/"MCP" ile öne çıkma — commodity |
| 3 | **Çok-provider maliyet/bütçe yönetimini sahiplen** | Yüksek | Orta-yüksek | CLI-only araçlar yapısal olarak yapamaz; ekipler faturayı hissederken zamanlama güçlü |
| 4 | **İki masa-bahsi eksiği kapat** — (a) mobil/uzak izle-&-onayla (b) opsiyonel container-per-agent izolasyon | Orta | Orta | Orca/Omnara/Sculptor burada önde; kendi izolasyon modelini de netleştir |
| 5 | **Windows-öncelikli/çapraz-platformu GTM kozu yap** | Orta | Orta | Liderlerin çoğu macOS-only; Rust+Tauri natif çapraz-platform |
| 6 | **İki tehdidi izle, "neden ayrı kokpit" cevabını keskinleştir** | Sürekli | Konumlandırma | Agent HQ + JetBrains Air; ACP'nin *üstüne* kattığın değeri net anlat |

---

## 08 · Ek — güven & kaynaklar

### Güven & uyarılar
- **Yüksek güven:** tüm canlı GitHub yıldızları/lisansları, resmi fiyatlar, Terragon & Vibe-Kanban-bulut kapanışı, Crystal→Nimbalyst, MCP/ACP kronolojisi, Devin $26B / Factory $1.5B / Cognition $10.2B.
- **Orta / ikincil:** Cursor ~$29.3B & $2B ARR (ikincil), Copilot 20M+ kullanıcı, SpaceX–Cursor $60B (duyuruldu, Q3-2026 kapanışı beklemede — kesin değil).
- **Düşük / doğrulanamadı:** Conductor ~$22M (ikincil), Sourcegraph değerlemesi (2021 bayat), Zencoder/Blackbox fonu opak. **"Kled"** adlı orkestratör doğrulanamadı — muhtemelen yanlış hatırlanan isim veya kamu ayak izi olmayan gizli ürün.
- **TAM yumuşaklığı:** analist tanımları 10 kat değişiyor; nokta değil aralık kullanıldı.

### Kaynaklar (seçme; her sayı briefing'de tam URL + tarihle)
- **Yerel orkestratörler:** GitHub API (canlı ★, 25 Tem 2026) · vibekanban.com/blog/shutdown · nimbalyst.com/crystal · imbue.com/blog/containers · mux.coder.com/llms.txt · ProductHunt/Show HN (Omnara #1, Mux 100pts)
- **Bulut/async:** Bloomberg (Cognition $26B, 27 May 2026) · TechCrunch (Factory $1.5B, 16 Nis 2026) · github.blog/welcome-home-agents (Agent HQ, 28 Eki 2025) · devin.ai/pricing · terragon-labs/terragon-oss (kapanış)
- **IDE / ACP:** zed.dev/acp · blog.jetbrains.com/ai (ACP + Air) · CNBC (Cursor $29.3B, 13 Kas 2025; SpaceX $60B, 16 Haz 2026) · cognition.com/blog/introducing-devin-desktop · The Register (Trae telemetri)
- **İkame & pazar:** GitHub API (Open WebUI 146.7k / LibreChat 41.3k ★) · TechCrunch (OpenRouter $1.3B, 26 May 2026) · Gartner (kurumsal kodlama-agent, Nis 2026) · SlashData 2025 (36.5M dev) · Stack Overflow / JetBrains 2025 (%84–85) · Forrester (Ara 2025) · a16z Big Ideas 2026

---

*Karar odağı örtük (konumlandırma/farklılaştırma/GTM). Belirli bir karar için (yatırım anlatısı, özellik önceliği, fiyatlandırma) rapor yeniden kesilebilir.*
