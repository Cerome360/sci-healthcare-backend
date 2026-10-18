# Privacy & Data Disclosure Specification

This document details the data exposed by each API endpoint, the audience permitted to query it, the on-chain origin of the data, and the privacy rationale for public disclosure.

---

## 1. Overview & Privacy Model

The SCI Healthcare backend is a **public, unauthenticated read-only indexer** for the SCI Healthcare care-voucher protocol on Stellar.

- **Audience:** The API is open to anyone on the Internet without authentication or API keys.
- **On-chain source of truth:** All data exposed by the API is derived from public Soroban smart contract events and ledger state on the Stellar network.
- **No Protected Health Information (PHI) / PII:** The protocol does not record, process, or store patient names, national identity numbers, medical histories, diagnostic notes, or clinical outcomes.
- **Cryptographic Beneficiary Pseudonymity:** Beneficiaries are identified solely by a 32-byte cryptographic commitment (`beneficiaryRef`), typically a SHA-256 hash or salted commitment generated off-chain. The API has no mechanism to resolve a `beneficiaryRef` to an individual's real-world identity.
- **Redaction in Bulk Channels:** High-throughput and export surfaces (such as CSV exports and real-time Server-Sent Events) deliberately omit `beneficiaryRef` to prevent broad correlation attacks.

---

## 2. Route-by-Route Exposure Specification

| Endpoint | Who Can Query | Data Exposed | On-Chain Source | Read-Model Additions | Privacy Rationale & Impact |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`GET /health`** | Public | Service health status (`ok`), current UTC timestamp | In-memory server state | None | Operational telemetry only; no protocol or user data. |
| **`GET /ready`** | Public | Database readiness, indexer latest/target ledger, sync lag, degraded flags | In-memory state & database cursor | None | System availability check for orchestration and load balancers. |
| **`GET /version`** | Public | Package version, git commit, network name, configured contract IDs | Environment configuration | None | Public contract IDs and build info; already public repository metadata. |
| **`GET /metrics`** | Public | Prometheus request counters, latency histograms, indexer lag gauges | In-memory metrics collectors | Aggregations | Anonymous operational telemetry; exempt from rate limiting. |
| **`GET /v1/providers`** | Public | List of registered clinic names, Stellar addresses, countries, operational status, active services | Registry contract `ProviderRegistered`, `ServiceAdded`, `ServiceRemoved` events | Pagination, name search (`q`), country and status filters | Clinics are public legal entities and licensed healthcare providers operating transparently on-chain. |
| **`GET /v1/providers/:address`** | Public | Single provider record: address, name, country, status, catalog of offered services and base prices | Registry contract state | Pre-computed decimal formatting (`priceDisplay`) | Standard public directory information for patient discovery. |
| **`GET /v1/services`** | Public | Catalog of active medical services across all clinics (service codes, labels, prices, clinic counts) | Registry contract service entries | Grouped catalog with min/max/median price calculation | Aggregated market pricing and standardized medical service codes (e.g., Code 101: Outpatient Consult). |
| **`GET /v1/services/:code`** | Public | Specific service code details and active clinic providers offering it | Registry contract service entries | Sorted by price ascending | Enables patients to locate affordable care; clinic pricing is public. |
| **`GET /v1/vouchers`** | Public | Voucher state: numeric ID, funder address, beneficiary hash (`beneficiaryRef`), provider address, service code, amount, status, timestamps | Voucher escrow contract `VoucherCreated`, `VoucherRedeemed`, `VoucherCancelled`, `VoucherExpired` events | Filtering by funder, provider, status, beneficiary hash; cursor pagination | Beneficiary identity is shielded behind a 32-byte hash commitment. Funder and provider are public Stellar accounts. Amounts represent monetary credits. |
| **`GET /v1/vouchers/:id`** | Public | Full voucher record matching the given ID | Voucher escrow contract state | Decimal amount formatting | Direct lookup of a known voucher. Beneficiary remains an unresolvable hash. |
| **`GET /v1/vouchers/:id/events`** | Public | Chronological ledger history for a voucher: event type, ledger sequence, timestamp, transaction hash | Soroban transaction and event log | Indexed chronological timeline | Verifiable audit trail of voucher transitions; mirrors public Stellar ledger. |
| **`GET /v1/vouchers/due`** | Public | Unredeemed vouchers nearing expiration (within specified hours) | Voucher escrow contract state | Filtered by `expiresAt <= now + delta` and status `Funded` | Allows clinics and automated keepers to process claims or clawbacks before expiration. |
| **`GET /v1/vouchers.csv`** | Public | Tabular CSV export of voucher history | Database read-model | RFC 4180 CSV serialization | **`beneficiaryRef` is strictly excluded** from CSV exports to prevent offline linkage and mass aggregation. |
| **`GET /v1/stats`** | Public | Protocol aggregates: counts by status (funded, redeemed, cancelled, expired), total disbursed volume | Database aggregate queries | Sums and counts | Pure macroeconomic statistics; no individual records exposed. |
| **`GET /v1/receipts`** | Public | Anonymized care receipts: receipt ID, voucher ID, provider address, clinic name, service code, settled amount, timestamp | Receipt contract `ReceiptMinted` events | Enriched with provider public profile (name, country) | Proof of care delivery. Contains no patient identifier, medical findings, or diagnostic details. |
| **`GET /v1/receipts/:id`** | Public | Single care receipt details | Receipt contract state | Formatted decimal amounts | Verifiable proof-of-redemption for donor reporting and accounting. |
| **`GET /v1/governance/proposals`** | Public | List of DAO governance proposals: proposal ID, title, status, vote weights, deadline | Governance contract `ProposalCreated`, `VoteCast`, `ProposalExecuted` events | Sorting and status filtering | DAO operations and public vote tallies. |
| **`GET /v1/governance/proposals/:id`** | Public | Single governance proposal details and calldata target | Governance contract state | Structured view | Open governance transparent to all DAO stakeholders. |
| **`GET /v1/governance/history`** | Public | Historical admin actions (provider approval/suspension, parameter changes) | Contract admin event logs | Indexed audit trail | Regulatory transparency and protocol governance auditing. |
| **`GET /v1/stream`** | Public | Real-time Server-Sent Events (SSE) for voucher transitions | In-process event bus | Push delivery filtering on voucher ID or provider address | **`beneficiaryRef` is strictly omitted** from SSE payloads. Stream cannot be used to scrape beneficiary commitments. |

---

## 3. Privacy Safeguards & Best Practices

1. **Beneficiary Anonymity:**
   Beneficiary references are created off-chain by humanitarian funders and clinics using cryptographic hashing. Even if a third party inspects the database, the commitment reveals no name, age, gender, contact info, or health status.

2. **No Health Record Linkage:**
   Vouchers encode general service codes (e.g., Code 101 for General Consultation) rather than detailed ICD-10 medical diagnoses, prescription records, or lab results. Medical records remain strictly within clinic local systems and are never stored in this backend or on-chain.

3. **Protection Against Bulk Scraping:**
   - Public rate limiting is enforced (`30 req/min` for list routes, `120 req/min` for other routes).
   - Real-time streams and CSV exports scrub sensitive commitment fields.
   - Paging uses bounded cursors (`limit <= 100`) preventing memory denial-of-service.

4. **Auditability Without Surveillance:**
   The design strikes a deliberate balance: donors and auditors can verify that funds were disbursed to legitimate clinics for healthcare services, while patient dignity and medical privacy are unconditionally preserved.
