# AI Studio (GCP)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built with Next.js](https://img.shields.io/badge/Built%20with-Next.js%2016-black)](https://nextjs.org/)
[![Cloud: GCP](https://img.shields.io/badge/Cloud-Google%20Cloud-4285F4?logo=googlecloud&logoColor=white)](./infra-gcp/README.md)
[![Upstream: PSD401](https://img.shields.io/badge/Upstream-psd401%2Faistudio-24292e?logo=github)](https://github.com/psd401/aistudio)

> **Sunnyside School District fork** — migrating PSD401's AI Studio from AWS to Google Cloud Platform.

AI Studio is an open-source platform that provides K-12 educators and students with access to cutting-edge generative AI models at **90% lower cost** than individual licenses. Built with privacy-first architecture and deployed within district infrastructure, it democratizes access to AI tools that were previously cost-prohibitive for schools.

This fork is maintained by [Sunnyside School District](https://www.sunnysideschools.org) (Washington State) and re-targets the platform at Google Cloud Platform. Upstream AWS work continues at [psd401/aistudio](https://github.com/psd401/aistudio).

## 🚧 Migration Status

This fork is **actively migrating from AWS to GCP**. Expect drift between this README, the `/infra` tree (legacy AWS CDK), and the `/infra-gcp` tree (GCP Terraform, active).

| Layer | Target | Status |
|-------|--------|--------|
| Infrastructure (Terraform root + 17 modules, 4 env stacks) | GCP — bootstrap, VPC + PSA, AlloyDB, Cloud Run, Vertex, DLP, Model Armor | **Scaffolded** — `infra-gcp/` |
| Identity & auth | AWS Cognito → Identity Platform (OIDC) | Planned |
| Database | Aurora Serverless v2 → AlloyDB (pgvector) | Planned |
| Compute | ECS Fargate → Cloud Run (web + job) | Planned |
| Storage | S3 → Cloud Storage (UBLA + CMEK + PAP) | Planned |
| Content safety | Bedrock Guardrails → Vertex Model Armor (HIGH_AND_ABOVE) | Planned |
| PII / DLP | Custom PII tokenization → Cloud DLP + custom `DOB_WITH_NAME` infoType | Planned |
| Observability | CloudWatch + ADOT → Cloud Logging, Cloud Monitoring, 7yr audit sink | Scaffolded in `infra-gcp/modules/observability` |

See [`docs/DEPLOYMENT-gcp.md`](./docs/DEPLOYMENT-gcp.md), [`docs/architecture/adr/ADR-007-gcp-migration.md`](./docs/architecture/adr/ADR-007-gcp-migration.md), and [`infra-gcp/README.md`](./infra-gcp/README.md) for details. FERPA controls for the GCP port live in the ADR and the `dlp` / `vpc-sc` modules.

## 🎬 See It In Action

Upstream project page (AWS-hosted reference deployment): [https://psd401.ai/aistudio](https://psd401.ai/aistudio)

AI Studio is a **self-hosted platform** deployed within your district infrastructure for security and compliance.

**Ready to deploy on GCP?** See the [GCP Deployment Guide](./docs/DEPLOYMENT-gcp.md). The original AWS guide lives at [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) and still applies to the `infra/` tree until the app-layer migration lands.

## 🎯 Why AI Studio?

### The Problem
- **Cost Barriers**: Individual AI subscriptions cost $20-200/month per user—unsustainable for districts
- **Access Inequality**: Students lack exposure to frontier models used in higher education and industry
- **Data Privacy**: Third-party AI services raise concerns about student data protection
- **Content Safety**: Consumer AI tools lack appropriate safeguards for K-12 environments
- **Complexity**: Creating custom AI assistants requires coding expertise

### The Solution
AI Studio eliminates these barriers by:
- **90% Cost Reduction**: Secure API architecture replaces expensive per-seat licenses
- **Multi-Model Access**: Real-time switching between GPT-5, Claude Opus, and Google Gemini
- **District-Level Security**: All data processed within your secure servers—nothing leaves your environment
- **K-12 Content Safety**: Automatic content filtering and PII protection across all AI interactions
- **No-Code Customization**: Design custom AI assistants using visual prompt chains
- **Open Source**: MIT-licensed, fully self-hostable on your infrastructure

## ✨ Key Features

### For Educators & Students

- 🤖 **Nexus Chat** - Conversational AI with multiple frontier models
  - Real-time streaming responses
  - Conversation history and organization
  - Model comparison side-by-side

- 🏗️ **Assistant Architect** - No-code custom AI assistant builder
  - Visual prompt chain designer
  - Variable substitution between prompts
  - Knowledge repository integration
  - Scheduled execution

- 📚 **Knowledge Repositories** - Upload and search documents
  - PDF, DOCX, TXT support with OCR
  - Vector embeddings for semantic search
  - Context-aware AI responses

- 📊 **Model Compare** - Side-by-side model evaluation
  - Compare GPT-5, Claude Opus, Gemini responses
  - Token usage and cost analysis
  - Performance metrics

### For Administrators

- 🔒 **Enterprise Security**
  - Identity Platform (OIDC) authentication with Google SSO _(GCP target — currently AWS Cognito on upstream)_
  - Role-based access control (RBAC)
  - Tool-level permissions
  - Audit logging routed to a 7-year retention Cloud Storage bucket via org-level log sink

- 🛡️ **K-12 Content Safety** - Purpose-built for educational environments
  - **Content Filtering**: Blocks inappropriate content (violence, hate speech, sexual content) in both inputs and AI responses using Vertex Model Armor at the `HIGH_AND_ABOVE` confidence threshold _(GCP target; upstream uses Bedrock Guardrails)_
  - **PII Protection**: Cloud DLP with a custom `DOB_WITH_NAME` infoType detects and tokenizes student personal information (names, emails, phone numbers, DOB co-occurrence) before sending to AI providers; daily scheduled scans cover at-rest data
  - **Compliance Ready**: Helps meet COPPA, FERPA, and CIPA requirements
  - **VPC-SC perimeter**: Production runs inside a VPC Service Controls perimeter (dry-run first, then enforce) to keep student data inside the GCP boundary
  - **Real-time Alerts**: Multi-channel notification fan-out (PagerDuty, Telegram, breakglass email) for safety and budget violations
  - **Zero Configuration**: Works automatically across all AI providers
  - See [K-12 Content Safety Documentation](./docs/features/k12-content-safety.md) for the upstream model. The GCP-specific privacy review lives in [`docs/architecture/adr/ADR-007-gcp-migration.md`](./docs/architecture/adr/ADR-007-gcp-migration.md).

- 💰 **Cost Control**
  - Transparent usage tracking
  - Per-user quotas and rate limiting
  - Provider cost comparison
  - Auto-pause dev environments

- 📈 **Monitoring & Observability**
  - Cloud Logging + Cloud Monitoring dashboards _(GCP target)_
  - Log-based tripwire metrics for privacy violations (DLP matches, Model Armor blocks, VPC-SC denials)
  - OpenTelemetry tracing
  - Circuit breaker for AI provider failures
  - Performance metrics

### Integration Platform

- 🔌 **API v1** - REST API for external integrations
  - Authenticated endpoints for assistants, decisions, and chat
  - API key management (`sk-` prefix tokens)
  - Rate limiting (60 req/min default)
  - OpenAPI specification at `docs/API/v1/openapi.yaml`

- 🔐 **OAuth2/OIDC Provider** - JWT-based auth for external apps
  - Authorization Code Flow with PKCE
  - Access tokens (15min), refresh tokens (24hr), ID tokens
  - Granular scopes for API, MCP, and OIDC
  - Admin UI for client registration at `/admin/oauth-clients`

- 🤖 **MCP Server** - Model Context Protocol for AI tool integrations
  - 5 tools: search decisions, capture decisions, list assistants, execute assistants, get context
  - Works with Claude Code, Cursor, and custom MCP clients
  - Authenticated via API key or OAuth token

- 🧭 **Decision Framework** - Structured decision capture & graph
  - Capture decisions with context, alternatives, and outcomes
  - Graph-based decision relationships
  - Search and retrieve past decisions for organizational knowledge

## 🏗️ Architecture

Targeting GCP with production-ready infrastructure (migration in progress — see [Migration Status](#-migration-status)):

- **Frontend**: Next.js 16 (App Router) with React 19 Server Components
- **Backend**: Cloud Run (web service) + Cloud Run Jobs (async processing) behind a global HTTPS Load Balancer with Cloud Armor + Cloud CDN
- **Database**: AlloyDB for PostgreSQL with `pgvector` enabled at the cluster level, accessed over Private Service Access (PSA), CMEK-encrypted
- **Authentication**: Identity Platform (multi-tenant, OIDC) + NextAuth v5
- **AI Providers**: OpenAI (GPT-5), Anthropic (Claude), Google (Gemini, Vertex AI) via AI SDK v6
- **Content Safety**: Vertex Model Armor (HIGH_AND_ABOVE) and Cloud DLP (custom `DOB_WITH_NAME` infoType + exclusion dictionary, daily scheduled scans)
- **Infrastructure**: Terraform (`google` / `google-beta` `~> 6.0`) under [`infra-gcp/`](./infra-gcp/) — 17 modules, 4 env stacks (`bootstrap`, `dev`, `staging`, `prod`)
- **Authentication for CI/CD**: Workload Identity Federation — GitHub Actions and the OpenClaw local runtime impersonate per-environment service accounts; no service-account keys
- **Network isolation**: VPC Service Controls perimeter around production
- **Streaming**: Server-Sent Events (SSE) over HTTP/2 for real-time responses

The legacy AWS topology (Cognito, ECS Fargate, Aurora Serverless v2, S3, AWS CDK) lives at [`infra/`](./infra/) and is the source of truth until the app-layer migration completes. See [Architecture Diagrams](./docs/diagrams/README.md) for the upstream visualizations.

## 🚀 Quick Start

### Prerequisites

- Node.js 20.x and Bun (or npm)
- Docker installed (for local PostgreSQL and container builds)
- For GCP deployment: `gcloud` CLI, `terraform >= 1.9`, and Workload Identity Federation configured (no SA keys)
- For legacy AWS deployment: AWS CLI + AWS CDK CLI (`npm install -g aws-cdk`)

### Local Development

```bash
# Clone repository
git clone https://github.com/nic-ssd201/aistudio-gcp.git
cd aistudio-gcp

# Install dependencies
bun install

# Copy environment variables
cp .env.example .env.local
# Edit .env.local with your configuration

# Start local PostgreSQL and dev server
bun run db:up              # Start PostgreSQL via Docker
bun run db:seed            # Create test users (first time)
bun run dev:local          # Start Next.js with local database
```

Open [http://localhost:3000](http://localhost:3000) to see the application.

### Deployment to GCP

The GCP infrastructure is split into a one-time `bootstrap` apply (run by an org admin) followed by environment stacks consumed via `terraform_remote_state`:

```bash
# 1. One-time org bootstrap (state bucket, WIF pool, Artifact Registry, audit sink)
#    Pre-create the shared project manually first; bootstrap adopts it via data source.
cd infra-gcp/envs/bootstrap
terraform init -backend-config="bucket=<state-bucket>" -backend-config="prefix=bootstrap"
terraform apply -var-file=prod.tfvars

# 2. Environment apply (dev / staging / prod)
cd ../dev
terraform init -backend-config="bucket=<state-bucket>" -backend-config="prefix=envs/dev"
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

See the [GCP Deployment Guide](./docs/DEPLOYMENT-gcp.md) and [`infra-gcp/README.md`](./infra-gcp/README.md) for the full procedure, including bootstrap pre-creation and per-env tfvars.

### Deployment to AWS (legacy upstream)

The original AWS CDK topology is preserved under [`infra/`](./infra/). See the upstream [AWS Deployment Guide](./docs/DEPLOYMENT.md) for `bunx cdk deploy` workflows. This path will be deprecated in this fork once the GCP app-layer migration completes.

## 📊 Cost Comparison

### Traditional Approach (Per-Seat Licenses)
```
100 users × $20/month (ChatGPT Plus) = $2,000/month = $24,000/year
```

### AI Studio (API-Based)
```
100 users × average 50,000 tokens/day
= 1.5M tokens/day × 30 days = 45M tokens/month
= $450/month (GPT-5) + $200 infrastructure = $650/month = $7,800/year

Savings: $16,200/year (67% reduction)
```

With mixed usage (Gemini + GPT-4 mini), costs drop to ~$200/month (**90% savings**).

## 🛠️ Tech Stack

### Frontend
- Next.js 16 with App Router
- React 19 with Server Components
- Shadcn UI component library
- Tailwind CSS for styling
- Vercel AI SDK v6 for streaming

### Backend (GCP target)
- Cloud Run (web) + Cloud Run Jobs (async processing, invoked via a Workflow intermediary from Eventarc per provider 6.x)
- AlloyDB for PostgreSQL (with `pgvector`)
- Drizzle ORM with postgres.js driver
- Cloud Storage for documents (UBLA + CMEK + PAP, lifecycle policies)
- Document AI / Vision API for OCR

### Infrastructure (GCP target)
- Terraform (`google` / `google-beta` `~> 6.0`) for Infrastructure as Code
- Shared VPC with Private Service Access for AlloyDB and a Serverless VPC Connector for Cloud Run
- Global HTTPS Load Balancer with Serverless NEG, Cloud Armor, Cloud CDN, managed certs
- Cloud Logging + Cloud Monitoring with multi-channel notification fan-out
- Secret Manager (user-managed replication + CMEK)
- Identity Platform (multi-tenant OIDC)
- Cloud KMS for CMEK across storage, secrets, and AlloyDB
- VPC Service Controls perimeter on production

### Legacy AWS stack (upstream / `infra/`)
- ECS Fargate, Aurora Serverless v2, AWS Lambda, S3, AWS Textract, AWS CDK, CloudWatch + ADOT, Secrets Manager, Cognito

## 📚 Documentation

### Core Documentation
- [GCP Deployment Guide](./docs/DEPLOYMENT-gcp.md) - Step-by-step GCP deployment **(this fork)**
- [GCP Demo Walkthrough](./docs/GCP_DEMO.md) - End-to-end demo of the GCP environment
- [ADR-007: GCP Migration](./docs/architecture/adr/ADR-007-gcp-migration.md) - Architecture decision record covering the AWS→GCP move, FERPA controls, and rollback posture
- [Architecture Overview](./docs/ARCHITECTURE.md) - Upstream system architecture (AWS-oriented)
- [AWS Deployment Guide](./docs/DEPLOYMENT.md) - Legacy AWS deployment (still applies to `infra/` until app-layer migration completes)
- [API Reference](./docs/API_REFERENCE.md) - REST endpoints and server actions
- [Error Reference](./docs/ERROR_REFERENCE.md) - Error codes and debugging
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - Common issues and solutions

### Infrastructure
- [GCP Terraform](./infra-gcp/README.md) - Terraform root, modules, and env stacks **(this fork)**
- [Legacy AWS CDK](./infra/README.md) - Upstream AWS CDK stack details
- [VPC Network Topology](./docs/diagrams/02-vpc-network-topology.md) (AWS reference)
- [AWS Service Architecture](./docs/diagrams/03-aws-service-architecture.md) (AWS reference)

### Visual Architecture
- [All Diagrams (9 total)](./docs/diagrams/README.md) - 10,000+ lines of visual documentation
- [Database ERD](./docs/diagrams/04-database-erd.md) - 54 PostgreSQL tables
- [Authentication Flow](./docs/diagrams/05-authentication-flow.md) - OAuth 2.0 flow
- [Streaming Architecture](./docs/diagrams/09-streaming-architecture.md) - SSE implementation

### Integration
- [API v1 Quickstart](./docs/guides/api-quickstart.md) - Getting started with the REST API
- [OAuth2 Integration](./docs/guides/oauth-integration.md) - Authenticating external apps
- [MCP Integration](./docs/guides/mcp-integration.md) - Connecting AI tools via MCP

### Development
- [Developer Guide](./DEVELOPER_GUIDE.md) - Development setup and workflow
- [Library Documentation](./lib/README.md) - Core utilities and patterns
- [CLAUDE.md](./CLAUDE.md) - AI assistant development guidelines

## 🧪 Testing

```bash
# Run test suite
npm test

# Run tests in watch mode
npm run test:watch

# Run linting
npm run lint

# Run type checking
npm run typecheck
```

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## 📄 License

MIT License - see [LICENSE](./LICENSE) file for details.

## 🙏 Acknowledgments

AI Studio was originally developed by **[Peninsula School District (PSD401)](https://www.psd401.net)** to bring world-class AI tools to K-12 education. This GCP fork is maintained by **[Sunnyside School District (SSD201)](https://www.sunnysideschools.org)** to retarget the platform at Google Cloud Platform. Both districts are MIT-licensed contributors; upstream AWS development continues at [psd401/aistudio](https://github.com/psd401/aistudio).

Built with:

- [Next.js](https://nextjs.org/) - React framework
- [Vercel AI SDK](https://sdk.vercel.ai/) - AI streaming infrastructure
- [Terraform](https://www.terraform.io/) + [Google Cloud Platform](https://cloud.google.com/) - Infrastructure as Code (this fork)
- [AWS CDK](https://aws.amazon.com/cdk/) - Infrastructure as Code (upstream)
- [Shadcn UI](https://ui.shadcn.com/) - UI component library

## 🔗 Links

- **This fork (GCP)**: [github.com/nic-ssd201/aistudio-gcp](https://github.com/nic-ssd201/aistudio-gcp)
- **Upstream (AWS)**: [github.com/psd401/aistudio](https://github.com/psd401/aistudio) · [psd401.ai/aistudio](https://psd401.ai/aistudio)
- **Documentation**: [docs/](./docs/) · [GCP-specific deployment](./docs/DEPLOYMENT-gcp.md)
- **GCP Terraform**: [infra-gcp/](./infra-gcp/)
- **Issues (this fork)**: [GitHub Issues](https://github.com/nic-ssd201/aistudio-gcp/issues)
- **Issues (upstream)**: [GitHub Issues](https://github.com/psd401/aistudio/issues)

---

**Built for K-12 education by PSD401 (upstream) and SSD201 (this GCP fork).**

*Making frontier AI accessible, secure, and affordable for every student.*
