#!/usr/bin/env bash
# =============================================================================
#  Card Conjurer – Proxmox LXC Setup Script
#  Run this on the Proxmox VE host as root.
#
#  What it does:
#    1. Creates a Debian 12 LXC container
#    2. Installs nginx + Node.js 20 (no Docker)
#    3. Clones the Card Conjurer repo and starts the API as a systemd service
#    4. Configures a Samba share for the local_art folder
# =============================================================================
set -euo pipefail

# ── Colours & helpers ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
info() { echo -e "\n${BOLD}▶ $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠${NC} $*"; }
die()  { echo -e "${RED}  ✗ ERROR:${NC} $*" >&2; exit 1; }
ask()  { printf "${BLUE}  ?${NC} %s " "$*"; }

# ── Preflight ─────────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Must be run as root on the Proxmox host."
command -v pct   &>/dev/null || die "pct not found – run this on a Proxmox VE host."
command -v pvesm &>/dev/null || die "pvesm not found – run this on a Proxmox VE host."
command -v pveam &>/dev/null || die "pveam not found – run this on a Proxmox VE host."

echo ""
echo -e "${BOLD}════════════════════════════════════════════${NC}"
echo -e "${BOLD}   Card Conjurer · Proxmox LXC Setup        ${NC}"
echo -e "${BOLD}════════════════════════════════════════════${NC}"

# ── Container parameters ──────────────────────────────────────────────────────
info "Container configuration"

NEXT_ID=$(pvesh get /cluster/nextid 2>/dev/null || echo 200)
ask "Container ID      [${NEXT_ID}]:";  read -r CT_ID;       CT_ID=${CT_ID:-$NEXT_ID}
ask "Hostname          [cardconjurer]:"; read -r CT_HOSTNAME; CT_HOSTNAME=${CT_HOSTNAME:-cardconjurer}
ask "CPU cores         [1]:";           read -r CT_CORES;    CT_CORES=${CT_CORES:-1}
ask "Memory MB         [512]:";         read -r CT_MEMORY;   CT_MEMORY=${CT_MEMORY:-512}
ask "Disk size GB      [4]:";           read -r CT_DISK;     CT_DISK=${CT_DISK:-4}

echo ""
pvesm status 2>/dev/null | awk 'NR==1{print "  "$0} NR>1{printf "  %-20s type=%-12s avail=%s\n",$1,$2,$5}'
ask "Storage pool      [local-lvm]:";  read -r CT_STORAGE; CT_STORAGE=${CT_STORAGE:-local-lvm}

echo ""
ip -br link show 2>/dev/null | awk '/^vmbr/{print "  " $1}' || true
ask "Network bridge    [vmbr0]:";      read -r CT_BRIDGE; CT_BRIDGE=${CT_BRIDGE:-vmbr0}
ask "IP/CIDR or 'dhcp' [dhcp]:";       read -r CT_IP;     CT_IP=${CT_IP:-dhcp}
CT_GW=""
if [[ "$CT_IP" != "dhcp" ]]; then
    ask "Gateway IP:"; read -r CT_GW
fi

# ── Passwords ─────────────────────────────────────────────────────────────────
info "Passwords"
ask "Container root password:"; read -rs CT_ROOT_PASS;  echo ""
ask "Confirm:";                  read -rs CT_ROOT_PASS2; echo ""
[[ "$CT_ROOT_PASS" == "$CT_ROOT_PASS2" ]] || die "Root passwords do not match."

# ── Web port ──────────────────────────────────────────────────────────────────
info "Web server"
ask "Listen port [80]:"; read -r WEB_PORT; WEB_PORT=${WEB_PORT:-80}

# ── Samba ─────────────────────────────────────────────────────────────────────
info "Samba share (for local_art folder)"
ask "Share username [artuser]:"; read -r SAMBA_USER; SAMBA_USER=${SAMBA_USER:-artuser}
ask "Share password:";           read -rs SAMBA_PASS;  echo ""
ask "Confirm:";                  read -rs SAMBA_PASS2; echo ""
[[ "$SAMBA_PASS" == "$SAMBA_PASS2" ]] || die "Samba passwords do not match."

# ── Repository ────────────────────────────────────────────────────────────────
info "Git repository"
echo "  Default: git@github.com:ivankrato/cardconjurer-sqlite.git"
ask "Use SSH key? (y/N):"; read -r USE_SSH; USE_SSH=${USE_SSH:-n}

SSH_KEY_PATH=""
REPO_URL="https://github.com/ivankrato/cardconjurer-sqlite.git"
if [[ "$USE_SSH" =~ ^[Yy]$ ]]; then
    ask "SSH private key path [~/.ssh/id_rsa]:"; read -r SSH_KEY_PATH
    SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_rsa}"
    SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"
    [[ -f "$SSH_KEY_PATH" ]] || die "Key not found: $SSH_KEY_PATH"
    REPO_URL="git@github.com:ivankrato/cardconjurer-sqlite.git"
fi

# ── Summary & confirm ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}─── Summary ──────────────────────────────────${NC}"
printf "  %-16s %s\n" "Container ID:"  "$CT_ID"
printf "  %-16s %s\n" "Hostname:"      "$CT_HOSTNAME"
printf "  %-16s %s  (%s core, %sG disk, %sMB RAM)\n" "Storage:" "$CT_STORAGE" "$CT_CORES" "$CT_DISK" "$CT_MEMORY"
printf "  %-16s %s  IP=%s\n"           "Network:"    "$CT_BRIDGE" "$CT_IP"
printf "  %-16s %s\n" "Web port:"      "$WEB_PORT"
printf "  %-16s %s\n" "Samba user:"    "$SAMBA_USER"
printf "  %-16s %s\n" "Repo:"          "$REPO_URL"
echo -e "${BOLD}──────────────────────────────────────────────${NC}"
ask "Proceed? (y/N):"; read -r CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ── Debian 12 template ────────────────────────────────────────────────────────
info "Preparing Debian 12 template"
TMPL_STORAGE="local"

warn "Updating template list (may take a moment)..."
pveam update 2>/dev/null || warn "pveam update failed – trying locally cached templates."

TMPL_NAME=$(pveam available --section system 2>/dev/null | awk '/debian-12/{print $2}' | sort -V | tail -1)
[[ -n "$TMPL_NAME" ]] || die "No Debian 12 template found. Try: pveam update"

if ! pveam list "$TMPL_STORAGE" 2>/dev/null | grep -qF "$TMPL_NAME"; then
    info "Downloading $TMPL_NAME ..."
    pveam download "$TMPL_STORAGE" "$TMPL_NAME"
fi
ok "Template: $TMPL_NAME"

# ── Create LXC container ──────────────────────────────────────────────────────
info "Creating container $CT_ID ..."

[[ "$CT_IP" == "dhcp" ]] \
    && NET_ARG="name=eth0,bridge=${CT_BRIDGE},ip=dhcp,ip6=auto" \
    || NET_ARG="name=eth0,bridge=${CT_BRIDGE},ip=${CT_IP}${CT_GW:+,gw=$CT_GW}"

pct create "$CT_ID" "${TMPL_STORAGE}:vztmpl/${TMPL_NAME}" \
    --hostname     "$CT_HOSTNAME"             \
    --rootfs       "${CT_STORAGE}:${CT_DISK}" \
    --cores        "$CT_CORES"                \
    --memory       "$CT_MEMORY"               \
    --swap         0                          \
    --net0         "$NET_ARG"                 \
    --password     "$CT_ROOT_PASS"            \
    --unprivileged 1                          \
    --features     nesting=1                  \
    --ostype       debian                     \
    --start        1

ok "Container created and started."
info "Waiting for container to initialise..."
sleep 8

# ── Push SSH key (if requested) ───────────────────────────────────────────────
if [[ "$USE_SSH" =~ ^[Yy]$ ]]; then
    info "Installing SSH key into container..."
    pct exec "$CT_ID" -- mkdir -p /root/.ssh
    pct exec "$CT_ID" -- chmod 700 /root/.ssh
    pct push "$CT_ID" "$SSH_KEY_PATH" /root/.ssh/id_rsa
    pct exec "$CT_ID" -- chmod 600 /root/.ssh/id_rsa
    pct exec "$CT_ID" -- bash -c \
        "ssh-keyscan -H github.com >> /root/.ssh/known_hosts 2>/dev/null; chmod 644 /root/.ssh/known_hosts"
    ok "SSH key installed."
fi

# ── Build inner setup script ──────────────────────────────────────────────────
#
# Escaping strategy for the unquoted SETUP_EOF heredoc:
#   ${VAR}   – expanded NOW by the outer script (literal values embedded)
#   \${VAR}  – backslash consumed here → ${VAR} survives into the inner script
#   nginx $uri / $host live inside a single-quoted 'NGINXEOF' heredoc inside
#   the generated script, so they are never seen by bash at all.

SETUP_TMP=$(mktemp /tmp/cc_lxc_XXXXXX.sh)
# shellcheck disable=SC2064
trap "rm -f '$SETUP_TMP'" EXIT

cat > "$SETUP_TMP" << SETUP_EOF
#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Values injected from the Proxmox host script at generation time:
WEB_PORT="${WEB_PORT}"
SAMBA_USER="${SAMBA_USER}"
SAMBA_PASS="${SAMBA_PASS}"
REPO_URL="${REPO_URL}"

step() { echo ""; echo -e "\033[1m==> \$1\033[0m"; }

# ── [1/7] System packages ─────────────────────────────────────────────────────
step "[1/7] Installing system packages"
apt-get update -qq
apt-get install -y --no-install-recommends \
    curl git nginx samba samba-common-bin \
    build-essential python3 ca-certificates gnupg lsb-release

# ── [2/7] Node.js 20 LTS ──────────────────────────────────────────────────────
step "[2/7] Installing Node.js 20 LTS"
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y nodejs
echo "  node \$(node --version)  /  npm \$(npm --version)"

# ── [3/7] Clone repository ────────────────────────────────────────────────────
step "[3/7] Cloning repository"
git clone "\${REPO_URL}" /opt/cardconjurer

# ── [4/7] Node.js dependencies ───────────────────────────────────────────────
step "[4/7] Installing Node.js dependencies"
cd /opt/cardconjurer/server
npm install --production

# ── [5/7] Directories & system user ──────────────────────────────────────────
step "[5/7] Creating directories and system user"
mkdir -p /opt/cardconjurer/data/db
mkdir -p /opt/cardconjurer/data/card_images
mkdir -p /opt/cardconjurer/local_art
useradd --system --no-create-home --shell /usr/sbin/nologin cardconjurer 2>/dev/null || true
chown -R cardconjurer:cardconjurer /opt/cardconjurer/data
chown -R cardconjurer:cardconjurer /opt/cardconjurer/server

# ── [6/7] Services ────────────────────────────────────────────────────────────
step "[6/7] Configuring services"

# systemd unit – single-quoted so no variable expansion occurs inside
cat > /etc/systemd/system/cardconjurer-api.service << 'SVCEOF'
[Unit]
Description=Card Conjurer API Server
After=network.target

[Service]
Type=simple
User=cardconjurer
WorkingDirectory=/opt/cardconjurer/server
Environment=PORT=3000
Environment=API_PORT=3001
Environment=DB_PATH=/opt/cardconjurer/data/db/cards.db
Environment=IMAGES_DIR=/opt/cardconjurer/data/card_images
Environment=GALLERY_HEADER=/opt/cardconjurer/gallery-header.html
ExecStart=/usr/bin/node /opt/cardconjurer/server/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable --now cardconjurer-api
echo "  cardconjurer-api service started."

# nginx – single-quoted 'NGINXEOF' keeps nginx dollar-variables literal.
# WEB_PORT is injected via a __placeholder__ that sed replaces afterwards.
cat > /etc/nginx/sites-available/cardconjurer << 'NGINXEOF'
server {
    listen __WEB_PORT__ default_server;
    server_name _;
    root /opt/cardconjurer;
    index index.html;
    charset utf-8;
    client_max_body_size 50m;

    location ~* \.(html?|json|xml|manifest|appcache)$ {
        expires -1;
    }

    location ~* \.(css|js|ttf|otf|woff2?|png|jpg|jpeg|svg|ico|webp|bmp|gif)$ {
        try_files \$uri =404;
        expires 1y;
        access_log off;
        add_header Cache-Control "public";
    }

    location /api/ {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
    }

    location = /cards {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
    }

    location ^~ /card-images/ {
        alias /opt/cardconjurer/data/card_images/;
        expires 1y;
        access_log off;
        add_header Cache-Control "public";
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
NGINXEOF

sed -i "s/__WEB_PORT__/\${WEB_PORT}/" /etc/nginx/sites-available/cardconjurer
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/cardconjurer /etc/nginx/sites-enabled/cardconjurer
nginx -t
systemctl enable --now nginx
systemctl restart nginx
echo "  nginx configured on port \${WEB_PORT}."

# ── [7/7] Samba ───────────────────────────────────────────────────────────────
step "[7/7] Configuring Samba"

useradd --no-create-home --shell /usr/sbin/nologin "\${SAMBA_USER}" 2>/dev/null || true
printf '%s\n%s\n' "\${SAMBA_PASS}" "\${SAMBA_PASS}" | smbpasswd -a -s "\${SAMBA_USER}"
chown root:"\${SAMBA_USER}" /opt/cardconjurer/local_art
chmod 775 /opt/cardconjurer/local_art

# Unquoted SAMBAEOF so \${SAMBA_USER} expands at run time
cat >> /etc/samba/smb.conf << SAMBAEOF

[cardconjurer-art]
   comment        = Card Conjurer Local Art
   path           = /opt/cardconjurer/local_art
   browseable     = yes
   read only      = no
   valid users    = \${SAMBA_USER}
   create mask    = 0664
   directory mask = 0775
   force group    = \${SAMBA_USER}
SAMBAEOF

systemctl enable --now smbd nmbd
systemctl restart smbd
echo "  Samba share 'cardconjurer-art' ready for user '\${SAMBA_USER}'."

# ── Cleanup ───────────────────────────────────────────────────────────────────
rm -f /root/.ssh/id_rsa 2>/dev/null || true
echo ""
echo "All steps completed successfully."
SETUP_EOF

# ── Push & run ────────────────────────────────────────────────────────────────
info "Pushing setup script to container $CT_ID ..."
pct push "$CT_ID" "$SETUP_TMP" /root/cc_setup.sh
pct exec "$CT_ID" -- chmod +x /root/cc_setup.sh

info "Running setup inside container (this takes a few minutes) ..."
pct exec "$CT_ID" -- /root/cc_setup.sh

pct exec "$CT_ID" -- rm -f /root/cc_setup.sh
ok "Container setup finished."

# ── Detect final IP ───────────────────────────────────────────────────────────
if [[ "$CT_IP" == "dhcp" ]]; then
    CONTAINER_IP=$(pct exec "$CT_ID" -- \
        ip -4 addr show eth0 2>/dev/null \
        | grep -oP '(?<=inet\s)\d+(\.\d+){3}' \
        || echo "<dhcp – check container>")
else
    CONTAINER_IP="${CT_IP%%/*}"
fi

URL_BASE="http://${CONTAINER_IP}"
[[ "$WEB_PORT" != "80" ]] && URL_BASE="${URL_BASE}:${WEB_PORT}"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}   Card Conjurer – Setup Complete!          ${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════${NC}"
echo ""
printf "  %-18s %s\n" "Container ID:"   "$CT_ID  ($CT_HOSTNAME)"
printf "  %-18s %s\n" "IP address:"     "$CONTAINER_IP"
echo ""
printf "  %-18s %s/\n"             "Web UI:"         "$URL_BASE"
printf "  %-18s %s/migrate.html\n" "Migration page:" "$URL_BASE"
echo ""
printf "  %-18s \\\\\\\\%s\\\\cardconjurer-art\n" "Samba share:" "$CONTAINER_IP"
printf "  %-18s %s\n"              "Samba user:"     "$SAMBA_USER"
echo ""
echo "  Useful commands:"
echo "    pct enter $CT_ID"
echo "    pct exec $CT_ID -- journalctl -fu cardconjurer-api"
echo "    pct exec $CT_ID -- systemctl status nginx cardconjurer-api smbd"
echo ""

