#!/bin/bash
# Output the local LAN IP for iOS dev. Use this to set VITE_API_URL in .env.ios.local
LAN_IP=$(ipconfig getifaddr en0)
echo "http://${LAN_IP}:3001/api"
