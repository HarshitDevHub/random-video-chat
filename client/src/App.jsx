import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL || 'http://localhost:3001'

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
}

const EMOJIS = ['😀', '😂', '😍', '👍', '🙏', '🔥', '❤️', '🎉']
const QUICK_MESSAGES = [
  'Hi 👋',
  'How are you?',
  'Nice to meet you!',
  'Can you hear me?',
  'One sec please',
]

const MicOnIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 15.5a3.5 3.5 0 0 0 3.5-3.5V7a3.5 3.5 0 1 0-7 0v5a3.5 3.5 0 0 0 3.5 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5.5 11.5v.5a6.5 6.5 0 0 0 13 0v-.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

const MicOffIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 15.5a3.5 3.5 0 0 0 3.5-3.5V11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M8.5 12V7a3.5 3.5 0 1 1 7 0v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M5.5 11.5v.5a6.5 6.5 0 0 0 9.2 5.92" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M4 4 20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

const CameraOnIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3.5" y="6.5" width="12" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.8" />
    <path d="m15.5 10 5-2.8v9.6l-5-2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const CameraOffIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3.5" y="6.5" width="12" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.8" />
    <path d="m15.5 10 5-2.8v9.6l-5-2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 4 20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

function App() {
  const [status, setStatus] = useState('Ready to start')
  const [connected, setConnected] = useState(false)
  const [inCall, setInCall] = useState(false)
  const [isStrangerConnecting, setIsStrangerConnecting] = useState(false)
  const [isWaitingForMatch, setIsWaitingForMatch] = useState(false)
  const [autoSearch, setAutoSearch] = useState(true)
  const [isMicOn, setIsMicOn] = useState(true)
  const [isVideoOn, setIsVideoOn] = useState(true)
  const [isPeerMicOn, setIsPeerMicOn] = useState(true)
  const [isPeerVideoOn, setIsPeerVideoOn] = useState(true)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState([])

  const socketRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const peerRef = useRef(null)
  const localStreamRef = useRef(null)
  const roomIdRef = useRef(null)
  const autoSearchRef = useRef(true)
  const pendingIceCandidatesRef = useRef([])
  const isRematchingRef = useRef(false)
  const chatBottomRef = useRef(null)
  const micOnRef = useRef(true)
  const videoOnRef = useRef(true)

  const clearChat = () => {
    setChatMessages([])
    setChatInput('')
  }

  const emitMediaState = (nextMicOn = micOnRef.current, nextVideoOn = videoOnRef.current) => {
    if (!socketRef.current?.connected || !roomIdRef.current) {
      return
    }

    socketRef.current.emit('media-state', {
      roomId: roomIdRef.current,
      micOn: nextMicOn,
      videoOn: nextVideoOn,
    })
  }

  const cleanupPeer = ({ clearRoom = true } = {}) => {
    if (peerRef.current) {
      peerRef.current.onicecandidate = null
      peerRef.current.ontrack = null
      peerRef.current.onconnectionstatechange = null
      peerRef.current.close()
      peerRef.current = null
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }

    pendingIceCandidatesRef.current = []
    setIsStrangerConnecting(false)
    setIsWaitingForMatch(false)
    setIsPeerMicOn(true)
    setIsPeerVideoOn(true)
    if (clearRoom) {
      roomIdRef.current = null
    }
    setInCall(false)
  }

  const requestMatch = () => {
    isRematchingRef.current = false
    if (!socketRef.current?.connected) {
      setStatus('Socket disconnected. Reconnecting...')
      return
    }
    setStatus('Searching for a random user...')
    setIsWaitingForMatch(true)
    clearChat()
    socketRef.current.emit('join-random')
  }

  const handlePeerGone = (reason) => {
    cleanupPeer()
    clearChat()
    setStatus(reason)
    if (autoSearchRef.current) {
      requestMatch()
    }
  }

  const rematchNow = (reason) => {
    if (isRematchingRef.current) {
      return
    }

    isRematchingRef.current = true
    cleanupPeer()
    clearChat()
    setStatus(reason)

    if (socketRef.current?.connected) {
      socketRef.current.emit('next-user')
    }
  }

  const createPeerConnection = async (initiator) => {
    if (!localStreamRef.current || !socketRef.current) {
      return
    }

    setIsStrangerConnecting(true)
    cleanupPeer({ clearRoom: false })
    setIsStrangerConnecting(true)

    const peer = new RTCPeerConnection(rtcConfig)
    peerRef.current = peer

    localStreamRef.current.getTracks().forEach((track) => {
      peer.addTrack(track, localStreamRef.current)
    })

    peer.ontrack = (event) => {
      const [stream] = event.streams
      if (stream && localStreamRef.current && stream.id === localStreamRef.current.id) {
        rematchNow('Sync issue detected. Connecting to a new user...')
        return
      }

      if (remoteVideoRef.current && stream) {
        remoteVideoRef.current.srcObject = stream
        setIsStrangerConnecting(false)
        remoteVideoRef.current.play().catch(() => {
          setStatus('Connected. Click the page once if remote audio is blocked.')
        })
      }
    }

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setIsStrangerConnecting(false)
        setStatus('You are now connected with a stranger')
      }
    }

    peer.onicecandidate = (event) => {
      if (!event.candidate || !roomIdRef.current) {
        return
      }
      socketRef.current.emit('signal', {
        roomId: roomIdRef.current,
        signal: { candidate: event.candidate },
      })
    }

    if (initiator) {
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      socketRef.current.emit('signal', {
        roomId: roomIdRef.current,
        signal: { description: peer.localDescription },
      })
    }

    setInCall(true)
  }

  useEffect(() => {
    let mounted = true

    const setupMediaAndSocket = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        })

        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        localStreamRef.current = stream
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
        }

        const socket = io(SIGNAL_URL, {
          transports: ['websocket'],
          autoConnect: true,
        })
        socketRef.current = socket

        socket.on('connect', () => {
          setConnected(true)
          setStatus('Connected to server')
          socket.emit('set-auto-search', { enabled: autoSearchRef.current })
          if (autoSearchRef.current && !roomIdRef.current) {
            requestMatch()
          }
        })

        socket.on('disconnect', () => {
          setConnected(false)
          setStatus('Server disconnected. Trying to reconnect...')
          cleanupPeer()
        })

        socket.on('waiting', () => {
          setStatus('Waiting for someone to connect...')
          setIsWaitingForMatch(true)
          setIsStrangerConnecting(false)
        })

        socket.on('matched', async ({ roomId, initiator }) => {
          roomIdRef.current = roomId
          clearChat()
          setIsPeerMicOn(true)
          setIsPeerVideoOn(true)
          setIsWaitingForMatch(false)
          setIsStrangerConnecting(true)
          setStatus('Connected! Starting call...')
          await createPeerConnection(initiator)
          emitMediaState()
          socket.emit('request-media-state', { roomId })
        })

        socket.on('signal', async ({ signal }) => {
          if (!peerRef.current) {
            return
          }

          if (signal.description) {
            await peerRef.current.setRemoteDescription(signal.description)

            while (pendingIceCandidatesRef.current.length > 0) {
              const candidate = pendingIceCandidatesRef.current.shift()
              await peerRef.current.addIceCandidate(candidate)
            }

            if (signal.description.type === 'offer') {
              const answer = await peerRef.current.createAnswer()
              await peerRef.current.setLocalDescription(answer)
              socket.emit('signal', {
                roomId: roomIdRef.current,
                signal: { description: peerRef.current.localDescription },
              })
            }
          }

          if (signal.candidate) {
            try {
              if (peerRef.current.remoteDescription) {
                await peerRef.current.addIceCandidate(signal.candidate)
              } else {
                pendingIceCandidatesRef.current.push(signal.candidate)
              }
            } catch {
              setStatus('Network change detected, syncing call...')
            }
          }
        })

        socket.on('peer-left', () => {
          handlePeerGone('Peer left the chat')
        })

        socket.on('peer-next', () => {
          handlePeerGone('Peer switched to next user')
        })

        socket.on('peer-disconnected', () => {
          handlePeerGone('Peer disconnected')
        })

        socket.on('chat-message', ({ message, createdAt }) => {
          setChatMessages((prev) => [
            ...prev,
            {
              id: `${createdAt || Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              sender: 'stranger',
              text: message,
            },
          ])
        })

        socket.on('peer-media-state', ({ micOn, videoOn }) => {
          setIsPeerMicOn(Boolean(micOn))
          setIsPeerVideoOn(Boolean(videoOn))
        })

        socket.on('request-media-state', () => {
          emitMediaState()
        })
      } catch {
        setStatus('Camera or microphone access failed')
      }
    }

    setupMediaAndSocket()

    return () => {
      mounted = false
      cleanupPeer()

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop())
      }

      if (socketRef.current) {
        socketRef.current.disconnect()
      }
    }
  }, [])

  useEffect(() => {
    autoSearchRef.current = autoSearch
    if (socketRef.current?.connected) {
      socketRef.current.emit('set-auto-search', { enabled: autoSearch })
    }
  }, [autoSearch])

  useEffect(() => {
    micOnRef.current = isMicOn
    videoOnRef.current = isVideoOn
    if (inCall) {
      emitMediaState(isMicOn, isVideoOn)
    }
  }, [isMicOn, isVideoOn, inCall])

  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages])

  const onLeave = () => {
    cleanupPeer()
    clearChat()
    if (socketRef.current?.connected) {
      socketRef.current.emit('leave-room')
    }
    setStatus('You left the chat')
  }

  const onNext = () => {
    cleanupPeer()
    clearChat()
    if (socketRef.current?.connected) {
      socketRef.current.emit('next-user')
      setStatus('Finding next random user...')
    }
  }

  const toggleMic = () => {
    if (!localStreamRef.current) {
      return
    }

    const nextState = !isMicOn
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = nextState
    })
    setIsMicOn(nextState)
    emitMediaState(nextState, isVideoOn)
  }

  const toggleVideo = () => {
    if (!localStreamRef.current) {
      return
    }

    const nextState = !isVideoOn
    localStreamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = nextState
    })
    setIsVideoOn(nextState)
    emitMediaState(isMicOn, nextState)
  }

  const sendChatMessage = (rawMessage) => {
    const trimmed = rawMessage.trim()
    if (!trimmed || !roomIdRef.current || !socketRef.current?.connected || !inCall) {
      return false
    }

    const message = trimmed.slice(0, 500)
    const now = Date.now()
    setChatMessages((prev) => [
      ...prev,
      {
        id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
        sender: 'you',
        text: message,
      },
    ])

    socketRef.current.emit('chat-message', {
      roomId: roomIdRef.current,
      message,
    })

    return true
  }

  const onSendMessage = (event) => {
    event.preventDefault()
    if (sendChatMessage(chatInput)) {
      setChatInput('')
    }
  }

  const onQuickMessage = (message) => {
    sendChatMessage(message)
  }

  const onPickEmoji = (emoji) => {
    setChatInput((prev) => `${prev}${emoji}`.slice(0, 500))
  }

  return (
    <main className="app">
      <section className="panel header-panel">
        <h1>Random Video Chat</h1>
        <p>{status}</p>
        <div className="status-row">
          <span className={connected ? 'dot online' : 'dot offline'}></span>
          <span>{connected ? 'Server Online' : 'Server Offline'}</span>
        </div>
      </section>

      <div className="content-layout">
        <div className="left-column">
          <section className="videos">
            <div className="video-card">
              <div className="video-title-row">
                <h2>You</h2>
                <span className={`state-chip ${isVideoOn ? 'on' : 'off'}`}>
                  {isVideoOn ? <CameraOnIcon /> : <CameraOffIcon />}
                  {isVideoOn ? 'Camera On' : 'Camera Off'}
                </span>
              </div>
              <div className={`video-frame ${isVideoOn ? '' : 'video-off'}`}>
                <video ref={localVideoRef} autoPlay muted playsInline />
                {!isVideoOn && (
                  <div className="video-off-overlay">
                    <CameraOffIcon />
                    <span>Camera Off</span>
                  </div>
                )}
              </div>
            </div>
            <div
              className={`video-card stranger-card ${
                isStrangerConnecting ? 'connecting' : isWaitingForMatch ? 'waiting' : ''
              }`}
            >
              <div className="video-title-row">
                <h2>Stranger</h2>
                <div className="peer-state-row">
                  <span className={`state-icon ${isPeerMicOn ? 'on' : 'off'}`} title={isPeerMicOn ? 'Mic on' : 'Mic off'}>
                    {isPeerMicOn ? <MicOnIcon /> : <MicOffIcon />}
                  </span>
                  <span className={`state-icon ${isPeerVideoOn ? 'on' : 'off'}`} title={isPeerVideoOn ? 'Camera on' : 'Camera off'}>
                    {isPeerVideoOn ? <CameraOnIcon /> : <CameraOffIcon />}
                  </span>
                </div>
              </div>
              {(isStrangerConnecting || isWaitingForMatch) && (
                <span className="connecting-label">
                  {isStrangerConnecting ? 'Connecting...' : 'Waiting for user...'}
                </span>
              )}
              <div className={`video-frame ${isPeerVideoOn ? '' : 'video-off'}`}>
                <video ref={remoteVideoRef} autoPlay playsInline />
                {!isPeerVideoOn && (
                  <div className="video-off-overlay peer">
                    <span className="peer-camera-off-icon" aria-label="Peer camera off" title="Peer camera off">
                      <CameraOffIcon />
                    </span>
                  </div>
                )}
                {!isPeerMicOn && (
                  <div className="peer-mic-off-badge" title="Peer microphone is off">
                    <MicOffIcon />
                    <span>Peer Mic Off</span>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="panel controls">
            <div className="buttons">
              <button onClick={requestMatch}>Start</button>
              <button onClick={onNext} disabled={!connected}>Next</button>
              <button onClick={onLeave} disabled={!inCall}>Leave</button>
            </div>
            <div className="media-toggles">
              <button
                type="button"
                className={`icon-toggle ${isMicOn ? 'on' : 'off'}`}
                onClick={toggleMic}
                title={isMicOn ? 'Turn microphone off' : 'Turn microphone on'}
                aria-label={isMicOn ? 'Turn microphone off' : 'Turn microphone on'}
              >
                {isMicOn ? <MicOnIcon /> : <MicOffIcon />}
              </button>
              <button
                type="button"
                className={`icon-toggle ${isVideoOn ? 'on' : 'off'}`}
                onClick={toggleVideo}
                title={isVideoOn ? 'Turn camera off' : 'Turn camera on'}
                aria-label={isVideoOn ? 'Turn camera off' : 'Turn camera on'}
              >
                {isVideoOn ? <CameraOnIcon /> : <CameraOffIcon />}
              </button>
            </div>
            <label className="auto-search">
              <input
                type="checkbox"
                checked={autoSearch}
                onChange={(event) => setAutoSearch(event.target.checked)}
              />
              Auto-search when peer disconnects
            </label>
          </section>

          <section className="panel tips">
            <h3>How it works</h3>
            <ul>
              <li>Press Start to enter the random queue.</li>
              <li>Press Next to switch instantly to another user.</li>
              <li>Press Leave to end the current chat.</li>
              <li>When auto-search is enabled, disconnections trigger a new match.</li>
            </ul>
          </section>
        </div>

        <section className="panel chat-panel">
          <h3>Chat</h3>
          <div className="chat-list" aria-live="polite">
            {chatMessages.length === 0 ? (
              <p className="chat-empty">No messages yet. Say hi when connected.</p>
            ) : (
              chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`chat-bubble ${msg.sender === 'you' ? 'you' : 'stranger'}`}
                >
                  {msg.text}
                </div>
              ))
            )}
            <div ref={chatBottomRef}></div>
          </div>

          <form className="chat-form" onSubmit={onSendMessage}>
            <input
              type="text"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder={inCall ? 'Type a message...' : 'Connect to start chatting'}
              disabled={!inCall}
              maxLength={500}
            />
            <button type="submit" disabled={!inCall || !chatInput.trim()}>
              Send
            </button>
          </form>

          <div className="emoji-row" aria-label="Emoji shortcuts">
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => onPickEmoji(emoji)}
                disabled={!inCall}
              >
                {emoji}
              </button>
            ))}
          </div>

          <div className="quick-row" aria-label="Quick messages">
            {QUICK_MESSAGES.map((message) => (
              <button
                key={message}
                type="button"
                onClick={() => onQuickMessage(message)}
                disabled={!inCall}
              >
                {message}
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}

export default App
