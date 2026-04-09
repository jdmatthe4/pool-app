# 🏊 Pool Control App

Web dashboard for your Pentair IntelliTouch/EasyTouch pool via the ScreenLogic gateway.

## Architecture

```
Browser  ──►  nginx (port 80)  ──►  /api/*  ──►  Node.js backend  ──►  ScreenLogic Gateway
                  │                                  (port 3000)            (LAN TCP)
                  └──►  React SPA (static files)
```

Everything runs in Docker on your VM. One command to start, one to stop.

---

## Quick Start

### 1. Install Docker on your Ubuntu VM

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker   # or log out and back in
```

### 2. Copy the project to your VM

```bash
# From your local machine:
scp pool-app.zip user@<vm-ip>:~

# On the VM:
unzip pool-app.zip -d pool-app && cd pool-app
```

### 3. Configure your gateway IP

```bash
cp .env.example .env
nano .env   # set SL_IP to your ScreenLogic gateway's IP
```

Find the gateway IP in your router's DHCP table — look for a device named "Pentair"
or with a MAC starting with 00:C0:33.

### 4. Build and start

```bash
docker compose up -d --build
```

Open `http://<your-vm-ip>` in your browser. Done.

---

## Daily Commands

```bash
docker compose up -d          # start
docker compose down           # stop
docker compose logs -f        # live logs (all services)
docker compose logs -f backend  # just the API logs
docker compose ps             # check status
docker compose up -d --build  # rebuild after code changes
```

---

## Accessing From Outside Your LAN

### Option A — Cloudflare Tunnel (Recommended)

No open router ports, no static IP needed, free SSL certificates automatically.

```bash
# Install cloudflared on the VM
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

# Authenticate (follow the printed URL in a browser)
cloudflared tunnel login

# Create tunnel and route
cloudflared tunnel create pool-app
cloudflared tunnel route dns pool-app pool.yourdomain.com

# Create ~/.cloudflared/config.yml:
# tunnel: <your-tunnel-id>
# credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json
# ingress:
#   - hostname: pool.yourdomain.com
#     service: http://localhost:80
#   - service: http_status:404

# Install as a background service (survives reboots)
sudo cloudflared service install
sudo systemctl start cloudflared
```

### Option B — Port Forward + DDNS

1. Forward port `443` on your router to `<vm-ip>:80`
2. Point a domain or DDNS hostname at your home IP
3. Add SSL: `sudo apt install certbot && sudo certbot --nginx`

---

## Troubleshooting

**"Connecting to gateway..." never loads**
```bash
docker compose logs backend
```
Look for timeout errors — means the backend can't reach the gateway.

**Gateway not found**
- Set `SL_IP` in `.env` to the gateway's LAN IP
- The VM must be on the same subnet as the gateway
- Confirm the gateway is online (check the phone app)

**Port 80 already in use**
Edit `docker-compose.yml` and change the port mapping:
```yaml
ports:
  - "8080:80"
```
Then access the app at `http://<vm-ip>:8080`.

**Force a clean rebuild**
```bash
docker compose down --rmi all
docker compose up -d --build
```
