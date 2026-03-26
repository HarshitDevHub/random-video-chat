# Random Video Chat App

A simple random video chat app built with React, Express, Socket.IO, and WebRTC.

## Features

- Random user matchmaking
- Video and audio call between two users
- Next button to switch to a new user
- Leave button to end current chat
- Auto-search option to reconnect with a new user when peer disconnects

## Run Locally

1. Install root tools:
   npm install
2. Run both backend and frontend:
   npm run dev
3. Open the frontend in your browser:
   http://localhost:5173

## Default Ports

- Frontend: 5173
- Backend signaling server: 3001

## Environment Variables

Frontend file: client/.env

VITE_SIGNAL_URL=http://localhost:3001

Backend file: server/server/.env

PORT=3001
CLIENT_ORIGIN=http://localhost:5173

## Notes

- For real internet deployment, use HTTPS and TURN servers for WebRTC reliability.
- This project uses STUN only for local/dev usage.
