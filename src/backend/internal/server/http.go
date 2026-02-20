package server

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	pulsarclient "github.com/apache/pulsar-client-go/pulsar"
	"github.com/gorilla/websocket"
	"github.com/jrui/pulsarviewer/internal/pulsar"
	"github.com/jrui/pulsarviewer/internal/store"
	"github.com/jrui/pulsarviewer/internal/stream"
)

type HTTPHandler struct {
	pulsarClient  *pulsar.ClientManager
	messageStore  *store.MessageStore
	streamManager *stream.StreamManager
	upgrader      websocket.Upgrader
	connections   map[string]*ConnectionState
	mu            sync.RWMutex
}

type ConnectionState struct {
	ID       string
	Cancel   context.CancelFunc
	Store    *store.MessageStore
	Created  time.Time
	LastSeen time.Time
}

func NewHTTPHandler(pulsarClient *pulsar.ClientManager, messageStore *store.MessageStore) http.Handler {
	mux := http.NewServeMux()
	handler := &HTTPHandler{
		pulsarClient:  pulsarClient,
		messageStore:  messageStore,
		streamManager: stream.NewStreamManager(pulsarClient, messageStore),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins in development
			},
		},
		connections: make(map[string]*ConnectionState),
	}

	// Determine the public directory path
	// The backend can be run from:
	// 1. Development: src/backend directory (cd src/backend && go run ./cmd/main.go)
	// 2. Tauri bundle: Inside Resources/_up_/src/backend/ (as bundled binary)
	// 3. CLI binary: Same directory as binary
	var publicDir string

	// Get the directory of the running binary
	exePath, _ := os.Executable()
	exeDir := filepath.Dir(exePath)

	// Try multiple paths to find the public directory
	possiblePaths := []string{
		// From development in src/backend
		"./public", // src/backend/public
		// From Tauri macOS bundle structure
		// The app structure is: PulsarViewer.app/Contents/Resources/_up_/src/backend/pulsarviewer-backend (binary)
		// Public files are at: PulsarViewer.app/Contents/Resources/_up_/public/
		filepath.Join(exeDir, "../../public"),
		filepath.Join(exeDir, "../../../public"),
		filepath.Join(exeDir, "../../../../public"),
		// Alternative paths if structure is different
		filepath.Join(exeDir, "../Resources/_up_/public"),
		filepath.Join(exeDir, "../../Resources/_up_/public"),
	}

	fmt.Printf("[Server] Executable path: %s\n", exePath)
	fmt.Printf("[Server] Executable dir: %s\n", exeDir)

	for _, path := range possiblePaths {
		absPath, _ := filepath.Abs(path)
		fmt.Printf("[Server] Trying public directory: %s\n", absPath)
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			publicDir, _ = filepath.Abs(path)
			fmt.Printf("[Server] ✓ Found public directory at: %s\n", publicDir)
			break
		}
	}

	if publicDir == "" {
		// Fallback to current directory's public
		publicDir = "public"
		fmt.Printf("[Server] WARNING: Using fallback public directory: %s\n", publicDir)
	}

	// Serve static files (React frontend)
	mux.Handle("/", http.FileServer(http.Dir(publicDir)))

	// REST API endpoints
	mux.HandleFunc("/api/messages", handler.handleGetMessages)
	mux.HandleFunc("/api/search", handler.handleSearch)
	mux.HandleFunc("/api/stats", handler.handleGetStats)
	mux.HandleFunc("/api/send", handler.handleSendMessage)
	mux.HandleFunc("/api/clear", handler.handleClearMessages)
	mux.HandleFunc("/api/export", handler.handleExportCSV)
	mux.HandleFunc("/api/import", handler.handleImportCSV)

	// WebSocket endpoint for streaming
	mux.HandleFunc("/api/stream", handler.handleStream)

	// Disconnect active stream
	mux.HandleFunc("/api/disconnect", handler.handleDisconnect)

	// Admin API proxy endpoints
	mux.HandleFunc("/api/admin/topics", handler.handleAdminTopics)
	mux.HandleFunc("/api/admin/topic-stats", handler.handleAdminTopicStats)
	mux.HandleFunc("/api/admin/topic-internal-stats", handler.handleAdminTopicInternalStats)
	mux.HandleFunc("/api/admin/subscriptions", handler.handleAdminSubscriptions)
	mux.HandleFunc("/api/admin/namespaces", handler.handleAdminNamespaces)
	mux.HandleFunc("/api/admin/check-permissions", handler.handleAdminCheckPermissions)

	// Health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	return mux
}

func (h *HTTPHandler) handleGetMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))

	if pageSize == 0 {
		pageSize = 50
	}

	messages, total := h.messageStore.GetPage(page, pageSize)

	// Ensure messages is never nil in JSON (use empty array instead)
	if messages == nil {
		messages = []*store.Message{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"messages":            messages,
		"page":                page,
		"pageSize":            pageSize,
		"currentPageMessages": len(messages),
		"totalMessages":       total,
		"totalPages":          (total + pageSize - 1) / pageSize,
	})
}

func (h *HTTPHandler) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		http.Error(w, "Missing search query", http.StatusBadRequest)
		return
	}

	isRegex := r.URL.Query().Get("regex") == "true"
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	if pageSize == 0 {
		pageSize = 50
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 0 {
		page = 0
	}

	// Search all messages
	allMatches := h.messageStore.Search(query, isRegex)
	total := len(allMatches)

	// Paginate results
	start := page * pageSize
	end := start + pageSize
	if end > total {
		end = total
	}

	var pageMessages []*store.Message
	if start < total {
		pageMessages = allMatches[start:end]
	}

	// Ensure pageMessages is never nil in JSON (use empty array instead)
	if pageMessages == nil {
		pageMessages = []*store.Message{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"messages":            pageMessages,
		"page":                page,
		"pageSize":            pageSize,
		"currentPageMessages": len(pageMessages),
		"totalMessages":       total,
		"totalPages":          (total + pageSize - 1) / pageSize,
		"searchQuery":         query,
		"isRegex":             isRegex,
	})
}

func (h *HTTPHandler) handleGetStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	count := h.messageStore.Count()
	isBuffering := h.messageStore.IsBuffering()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"totalMessages": count,
		"isBuffering":   isBuffering,
		"connections":   len(h.connections),
		"timestamp":     time.Now().Unix(),
	})
}

func (h *HTTPHandler) handleSendMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		ServiceURL string `json:"serviceUrl"`
		Topic      string `json:"topic"`
		Payload    string `json:"payload"`
		Key        string `json:"key,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	if req.ServiceURL == "" || req.Topic == "" || req.Payload == "" {
		http.Error(w, "Missing required fields", http.StatusBadRequest)
		return
	}

	client, err := h.pulsarClient.GetOrCreateClient(req.ServiceURL, "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	producer, err := client.CreateProducer(pulsarclient.ProducerOptions{
		Topic:                   req.Topic,
		SendTimeout:             30 * time.Second,
		DisableBatching:         false,
		BatchingMaxPublishDelay: 1 * time.Millisecond,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer producer.Close()

	msgID, err := producer.Send(context.Background(), &pulsarclient.ProducerMessage{
		Payload: []byte(req.Payload),
		Key:     req.Key,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":        true,
		"messageId": msgID.String(),
	})
}

func (h *HTTPHandler) handleClearMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	h.messageStore.Clear()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"message": "Messages cleared",
	})
}

func (h *HTTPHandler) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	messages := h.messageStore.GetAll()

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", `attachment; filename="messages.csv"`)

	cw := csv.NewWriter(w)
	if err := cw.Write([]string{"msg_timestamp", "data"}); err != nil {
		http.Error(w, "Failed to write CSV header", http.StatusInternalServerError)
		return
	}

	// PublishTime is Unix milliseconds in Pulsar
	for _, msg := range messages {
		ts := time.Unix(0, msg.PublishTime*int64(time.Millisecond)).UTC().Format(time.RFC3339Nano)
		data := msg.Payload
		if err := cw.Write([]string{ts, data}); err != nil {
			http.Error(w, "Failed to write CSV row", http.StatusInternalServerError)
			return
		}
	}

	cw.Flush()
	if cw.Error() != nil {
		http.Error(w, "Failed to flush CSV", http.StatusInternalServerError)
		return
	}
}

func (h *HTTPHandler) handleImportCSV(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	const maxFormMem = 32 << 20 // 32 MB
	if err := r.ParseMultipartForm(maxFormMem); err != nil {
		http.Error(w, "Failed to parse form: "+err.Error(), http.StatusBadRequest)
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Missing or invalid file: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	serviceURL := strings.TrimSpace(r.FormValue("serviceUrl"))
	topic := strings.TrimSpace(r.FormValue("topic"))
	token := strings.TrimSpace(r.FormValue("token"))

	if serviceURL == "" || topic == "" {
		http.Error(w, "Missing serviceUrl or topic", http.StatusBadRequest)
		return
	}

	cr := csv.NewReader(file)
	records, err := cr.ReadAll()
	if err != nil {
		http.Error(w, "Invalid CSV: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Count rows to send (skip header, skip rows with < 2 columns)
	total := 0
	for i, row := range records {
		if i == 0 {
			continue
		}
		if len(row) >= 2 {
			total++
		}
	}

	client, err := h.pulsarClient.GetOrCreateClient(serviceURL, token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	producer, err := client.CreateProducer(pulsarclient.ProducerOptions{
		Topic:                   topic,
		SendTimeout:             60 * time.Second,
		DisableBatching:         false,
		BatchingMaxPublishDelay: 1 * time.Millisecond,
		BatchingMaxMessages:    2000,
		MaxPendingMessages:      10000,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer producer.Close()

	// Stream progress as SSE
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	writeSSE := func(obj map[string]interface{}) {
		data, _ := json.Marshal(obj)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}

	ctx := context.Background()
	var wg sync.WaitGroup
	var mu sync.Mutex
	sent := 0
	var firstErr error
	const progressInterval = 100 // emit progress every N messages

	for i, row := range records {
		if i == 0 {
			continue
		}
		if len(row) < 2 {
			continue
		}
		payload := row[1]
		msg := &pulsarclient.ProducerMessage{Payload: []byte(payload)}
		wg.Add(1)
		producer.SendAsync(ctx, msg, func(_ pulsarclient.MessageID, _ *pulsarclient.ProducerMessage, err error) {
			defer wg.Done()
			mu.Lock()
			if err != nil && firstErr == nil {
				firstErr = err
			}
			sent++
			cur := sent
			mu.Unlock()
			if cur%progressInterval == 0 || cur == total {
				mu.Lock()
				writeSSE(map[string]interface{}{"sent": sent, "total": total})
				mu.Unlock()
			}
		})
	}

	wg.Wait()
	if firstErr != nil {
		writeSSE(map[string]interface{}{"error": firstErr.Error(), "sent": sent})
		return
	}
	writeSSE(map[string]interface{}{"done": true, "sent": sent})
}

type StreamRequest struct {
	ServiceURL       string `json:"serviceUrl"`
	Topic            string `json:"topic"`
	Subscription     string `json:"subscription"`
	SubscriptionType string `json:"subscriptionType"`
	InitialPosition  string `json:"initialPosition"`
	Token            string `json:"token,omitempty"`
}

type StreamMessage struct {
	Type string      `json:"type"` // "info", "error", "stats", "message"
	Data interface{} `json:"data"`
}

func applyStreamDefaults(req StreamRequest) StreamRequest {
	if req.Subscription == "" {
		req.Subscription = "viewer-sub"
	}
	if req.SubscriptionType == "" {
		req.SubscriptionType = "Exclusive"
	}
	if req.InitialPosition == "" {
		req.InitialPosition = "latest"
	}
	return req
}

func parseStreamRequestFromWebSocket(conn *websocket.Conn) (StreamRequest, error) {
	var req StreamRequest
	if err := conn.ReadJSON(&req); err != nil {
		return req, err
	}
	req = applyStreamDefaults(req)
	if req.ServiceURL == "" || req.Topic == "" {
		return req, fmt.Errorf("missing serviceUrl or topic")
	}
	return req, nil
}

func parseStreamRequestFromHTTP(r *http.Request) (StreamRequest, error) {
	q := r.URL.Query()
	req := StreamRequest{
		ServiceURL:       q.Get("serviceUrl"),
		Topic:            q.Get("topic"),
		Subscription:     q.Get("subscription"),
		SubscriptionType: q.Get("subscriptionType"),
		InitialPosition:  q.Get("initialPosition"),
		Token:            q.Get("token"),
	}

	// If body exists (POST), merge body fields over query defaults
	if r.Method == http.MethodPost {
		var bodyReq StreamRequest
		if err := json.NewDecoder(r.Body).Decode(&bodyReq); err != nil && err != io.EOF {
			return req, err
		}
		if bodyReq.ServiceURL != "" {
			req.ServiceURL = bodyReq.ServiceURL
		}
		if bodyReq.Topic != "" {
			req.Topic = bodyReq.Topic
		}
		if bodyReq.Subscription != "" {
			req.Subscription = bodyReq.Subscription
		}
		if bodyReq.SubscriptionType != "" {
			req.SubscriptionType = bodyReq.SubscriptionType
		}
		if bodyReq.InitialPosition != "" {
			req.InitialPosition = bodyReq.InitialPosition
		}
		if bodyReq.Token != "" {
			req.Token = bodyReq.Token
		}
	}

	req = applyStreamDefaults(req)
	if req.ServiceURL == "" || req.Topic == "" {
		return req, fmt.Errorf("missing serviceUrl or topic")
	}
	return req, nil
}

func (h *HTTPHandler) handleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check if this is a WebSocket upgrade request
	if r.Header.Get("Upgrade") == "websocket" {
		conn, err := h.upgrader.Upgrade(w, r, nil)
		if err != nil {
			http.Error(w, "WebSocket upgrade failed", http.StatusBadRequest)
			return
		}
		defer conn.Close()
		h.handleWebSocketStream(conn, r)
	} else {
		// Handle as SSE/HTTP stream
		h.handleHTTPStream(w, r)
	}
}

func (h *HTTPHandler) handleWebSocketStream(conn *websocket.Conn, r *http.Request) {
	req, err := parseStreamRequestFromWebSocket(conn)
	if err != nil {
		conn.WriteJSON(StreamMessage{Type: "error", Data: err.Error()})
		return
	}

	// Helper to classify fatal errors to avoid endless reconnects
	isFatal := func(e error) bool {
		if e == nil {
			return false
		}
		le := strings.ToLower(e.Error())
		fatalHints := []string{
			"invalid topic name",
			"topic does not exist",
			"not found",
			"does not exist",
			"unauthorized",
			"authorization",
			"permission",
		}
		for _, h := range fatalHints {
			if strings.Contains(le, h) {
				return true
			}
		}
		return false
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Create new message store for this connection
	connStore := store.NewMessageStore(10000)
	connID := time.Now().Format("20060102150405")

	h.mu.Lock()
	h.connections[connID] = &ConnectionState{
		ID:      connID,
		Cancel:  cancel,
		Store:   connStore,
		Created: time.Now(),
	}
	h.mu.Unlock()

	// Enable buffering when connection starts
	h.messageStore.SetBuffering(true)

	defer func() {
		h.mu.Lock()
		delete(h.connections, connID)
		h.mu.Unlock()
	}()

	// Connect to Pulsar
	conn.WriteJSON(StreamMessage{Type: "info", Data: map[string]string{"message": "Connecting to Pulsar...", "connectionId": connID}})

	var messageChan <-chan *pulsar.Message
	reconnectTicker := time.NewTicker(5 * time.Second)
	defer reconnectTicker.Stop()

	// Initial connection
	messageChan, err = h.pulsarClient.StreamMessages(ctx, pulsar.ConsumerConfig{
		ServiceURL:       req.ServiceURL,
		Topic:            req.Topic,
		Subscription:     req.Subscription,
		SubscriptionType: req.SubscriptionType,
		InitialPosition:  req.InitialPosition,
		Token:            req.Token,
	})

	if err != nil {
		conn.WriteJSON(StreamMessage{Type: "error", Data: err.Error()})
		// Stop early on fatal misconfiguration to avoid noisy retries
		if isFatal(err) {
			return
		}
		return
	}

	conn.WriteJSON(StreamMessage{Type: "info", Data: map[string]string{"message": "Connected. Streaming messages."}})

	// Ticker for periodic stats
	statsTicker := time.NewTicker(2 * time.Second)
	defer statsTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case msg, ok := <-messageChan:
			if !ok {
				// Consumer closed - attempt to reconnect
				conn.WriteJSON(StreamMessage{Type: "info", Data: map[string]string{"message": "Consumer disconnected, attempting to reconnect..."}})

				select {
				case <-reconnectTicker.C:
					// Try to reconnect
					newChan, err := h.pulsarClient.StreamMessages(ctx, pulsar.ConsumerConfig{
						ServiceURL:       req.ServiceURL,
						Topic:            req.Topic,
						Subscription:     req.Subscription,
						SubscriptionType: req.SubscriptionType,
						InitialPosition:  req.InitialPosition,
						Token:            req.Token,
					})
					if err != nil {
						conn.WriteJSON(StreamMessage{Type: "error", Data: map[string]string{"message": "Reconnect failed: " + err.Error()}})
						if isFatal(err) {
							// Stop reconnect loop on fatal errors
							conn.WriteJSON(StreamMessage{Type: "info", Data: map[string]string{"message": "Stopping reconnects due to fatal error"}})
							return
						}
					} else {
						messageChan = newChan
						conn.WriteJSON(StreamMessage{Type: "info", Data: map[string]string{"message": "Reconnected successfully"}})
					}
				case <-ctx.Done():
					return
				}
				break
			}
			// Store message but don't send it through WebSocket
			// Pause buffering when first page (100) of messages is reached
			storeMsg := toStoreMessage(msg)
			if storeMsg != nil {
				// Only add to stores if buffering is enabled or we're below threshold
				if h.messageStore.IsBuffering() || h.messageStore.Count() < 100 {
					connStore.Add(storeMsg)
					h.messageStore.Add(storeMsg)
				}
				// Once we reach 100 messages, pause buffering
				if h.messageStore.Count() >= 100 && h.messageStore.IsBuffering() {
					h.messageStore.SetBuffering(false)
				}
			}

		case <-statsTicker.C:
			stats := map[string]interface{}{
				"totalMessages": connStore.Count(),
				"isBuffering":   h.messageStore.IsBuffering(),
				"totalSizeMB":   float64(0),
				"timestamp":     time.Now().Unix(),
			}
			if err := conn.WriteJSON(StreamMessage{Type: "stats", Data: stats}); err != nil {
				return
			}
		}
	}
}

func (h *HTTPHandler) handleHTTPStream(w http.ResponseWriter, r *http.Request) {
	// Parse request first
	req, err := parseStreamRequestFromHTTP(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Ensure we have a persistent stream for this topic
	err = h.streamManager.GetOrCreateStream(stream.StreamKey{
		ServiceURL:       req.ServiceURL,
		Topic:            req.Topic,
		Subscription:     req.Subscription,
		SubscriptionType: req.SubscriptionType,
		InitialPosition:  req.InitialPosition,
		Token:            req.Token,
	})
	if err != nil {
		http.Error(w, "Failed to start stream: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// For HTTP streaming (Server-Sent Events)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// Flush headers immediately
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Server does not support streaming", http.StatusInternalServerError)
		return
	}
	flusher.Flush()

	connID := time.Now().Format("20060102150405")

	// Announce connection ID
	if err := writeSSEEvent(w, "info", map[string]string{
		"message":      "Connected. Streaming messages.",
		"connectionId": connID,
	}); err != nil {
		return
	}

	// Stream from global message store
	lastIndex := 0
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	tickerSwitched := false // Track if we've switched to slower updates

	for {
		select {
		case <-r.Context().Done():
			return

		case <-ticker.C:
			// Send new messages that have arrived
			messages := h.messageStore.GetAll()
			if len(messages) > lastIndex {
				for _, msg := range messages[lastIndex:] {
					if err := writeSSEEvent(w, "message", map[string]interface{}{
						"id":          msg.ID,
						"publishTime": msg.PublishTime,
						"eventTime":   msg.EventTime,
						"properties":  msg.Properties,
						"key":         msg.Key,
						"payload":     msg.Payload,
						"json":        msg.JSON,
					}); err != nil {
						return
					}
				}
				lastIndex = len(messages)
			}

			// Send periodic stats
			messages = h.messageStore.GetAll()
			sizeGB := h.messageStore.GetSizeGB()
			sizeMB := sizeGB * 1024 // Convert GB to MB
			stats := map[string]interface{}{
				"totalMessages": len(messages),
				"isBuffering":   h.messageStore.IsBuffering(),
				"totalSizeMB":   sizeMB,
				"isFull":        h.messageStore.IsFull(),
				"timestamp":     time.Now().Unix(),
			}
			if err := writeSSEEvent(w, "stats", stats); err != nil {
				return
			}

			// Switch to slower updates (5 sec) after initial page fills (100 messages)
			if !tickerSwitched && len(messages) >= 100 {
				ticker.Stop()
				ticker = time.NewTicker(5 * time.Second)
				tickerSwitched = true
			}

			// If store is full, send done event and close
			if h.messageStore.IsFull() {
				_ = writeSSEEvent(w, "done", map[string]string{
					"message": "Storage limit reached (1 GB). Streaming complete.",
				})
				return
			}
		}
	}
}

// toStoreMessage converts a pulsar.Message to the store.Message shape used by buffers.
func toStoreMessage(msg *pulsar.Message) *store.Message {
	if msg == nil {
		return nil
	}
	return &store.Message{
		ID:          msg.ID,
		PublishTime: msg.PublishTime,
		EventTime:   msg.EventTime,
		Properties:  msg.Properties,
		Key:         msg.Key,
		Payload:     msg.Payload,
		JSON:        msg.JSON,
	}
}

func (h *HTTPHandler) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	h.streamManager.Close()
	h.messageStore.Clear()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
}

// adminHTTPBase derives candidate Pulsar HTTP admin base URLs from a broker service URL.
// Returns a slice of URLs to try in order (port-specific first, then port-less fallback).
//
//	pulsar://host:6650  → [http://host:8080, http://host]
//	pulsar+ssl://host   → [https://host:8443, https://host]
//	http://host:8080    → [http://host:8080]   (used as-is, no fallback needed)
func adminHTTPBases(serviceURL string) ([]string, error) {
	u, err := url.Parse(serviceURL)
	if err != nil {
		return nil, fmt.Errorf("invalid serviceUrl: %w", err)
	}
	switch u.Scheme {
	case "pulsar":
		host := u.Hostname()
		return []string{
			fmt.Sprintf("http://%s:8080", host),
			fmt.Sprintf("http://%s", host),
		}, nil
	case "pulsar+ssl":
		host := u.Hostname()
		return []string{
			fmt.Sprintf("https://%s:8443", host),
			fmt.Sprintf("https://%s", host),
		}, nil
	case "http", "https":
		base := fmt.Sprintf("%s://%s", u.Scheme, u.Host)
		// If the URL already has an explicit port, also offer the port-less fallback
		if u.Port() != "" {
			return []string{base, fmt.Sprintf("%s://%s", u.Scheme, u.Hostname())}, nil
		}
		return []string{base}, nil
	default:
		host := u.Hostname()
		if host == "" {
			host = u.Host
		}
		return []string{
			fmt.Sprintf("http://%s:8080", host),
			fmt.Sprintf("http://%s", host),
		}, nil
	}
}

// adminRequest tries each base URL in order and returns the first successful response.
// A response is considered "successful" for routing purposes even if the HTTP status
// is 4xx (auth errors etc.) — we only retry on connection/network errors.
func adminRequest(bases []string, token, path string) ([]byte, int, error) {
	httpClient := &http.Client{Timeout: 10 * time.Second}
	var lastErr error
	for _, base := range bases {
		req, err := http.NewRequest(http.MethodGet, base+path, nil)
		if err != nil {
			lastErr = err
			continue
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue // try next base
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		return body, resp.StatusCode, err
	}
	return nil, 0, fmt.Errorf("admin API unreachable (tried %v): %w", bases, lastErr)
}

func (h *HTTPHandler) handleAdminTopics(w http.ResponseWriter, r *http.Request) {
	serviceURL := r.URL.Query().Get("serviceUrl")
	namespace := r.URL.Query().Get("namespace")
	token := r.URL.Query().Get("token")

	if serviceURL == "" || namespace == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "serviceUrl and namespace are required"})
		return
	}

	bases, err := adminHTTPBases(serviceURL)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}

	// Try persistent topics
	persistent, pStatus, pErr := adminRequest(bases, token, "/admin/v2/persistent/"+namespace)
	// Try non-persistent topics
	nonPersistent, npStatus, npErr := adminRequest(bases, token, "/admin/v2/non-persistent/"+namespace)

	w.Header().Set("Content-Type", "application/json")

	if pErr != nil && npErr != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Admin API unreachable: " + pErr.Error()})
		return
	}

	var allTopics []string
	if pErr == nil && pStatus == http.StatusOK {
		var topics []string
		if err := json.Unmarshal(persistent, &topics); err == nil {
			allTopics = append(allTopics, topics...)
		}
	}
	if npErr == nil && npStatus == http.StatusOK {
		var topics []string
		if err := json.Unmarshal(nonPersistent, &topics); err == nil {
			allTopics = append(allTopics, topics...)
		}
	}

	if allTopics == nil {
		allTopics = []string{}
	}

	isAuthErr := func(s int) bool { return s == http.StatusUnauthorized || s == http.StatusForbidden }

	// Only surface an auth warning if no topics were returned AND at least one
	// request was rejected for auth reasons. A 403 on non-persistent topics when
	// persistent ones succeed is normal on many clusters (not an auth problem).
	authFailed := len(allTopics) == 0 && (isAuthErr(pStatus) || isAuthErr(npStatus))

	json.NewEncoder(w).Encode(map[string]interface{}{
		"topics":     allTopics,
		"authFailed": authFailed,
	})
}

func (h *HTTPHandler) handleAdminTopicStats(w http.ResponseWriter, r *http.Request) {
	serviceURL := r.URL.Query().Get("serviceUrl")
	topic := r.URL.Query().Get("topic")
	token := r.URL.Query().Get("token")

	w.Header().Set("Content-Type", "application/json")

	if serviceURL == "" || topic == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "serviceUrl and topic are required"})
		return
	}

	bases, err := adminHTTPBases(serviceURL)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}

	topicPath := topicToAdminPath(topic, "stats")
	body, status, err := adminRequest(bases, token, topicPath)

	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Admin API unreachable: " + err.Error()})
		return
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Unauthorized: token lacks read permissions", "authFailed": true})
		return
	}
	w.WriteHeader(status)
	w.Write(body)
}

func (h *HTTPHandler) handleAdminTopicInternalStats(w http.ResponseWriter, r *http.Request) {
	serviceURL := r.URL.Query().Get("serviceUrl")
	topic := r.URL.Query().Get("topic")
	token := r.URL.Query().Get("token")

	w.Header().Set("Content-Type", "application/json")

	if serviceURL == "" || topic == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "serviceUrl and topic are required"})
		return
	}

	bases, err := adminHTTPBases(serviceURL)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}

	topicPath := topicToAdminPath(topic, "internalStats")
	body, status, err := adminRequest(bases, token, topicPath)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Admin API unreachable: " + err.Error()})
		return
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Unauthorized: token lacks read permissions", "authFailed": true})
		return
	}
	w.WriteHeader(status)
	w.Write(body)
}

func (h *HTTPHandler) handleAdminSubscriptions(w http.ResponseWriter, r *http.Request) {
	serviceURL := r.URL.Query().Get("serviceUrl")
	topic := r.URL.Query().Get("topic")
	token := r.URL.Query().Get("token")

	w.Header().Set("Content-Type", "application/json")

	if serviceURL == "" || topic == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "serviceUrl and topic are required"})
		return
	}

	bases, err := adminHTTPBases(serviceURL)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}

	topicPath := topicToAdminPath(topic, "subscriptions")
	body, status, err := adminRequest(bases, token, topicPath)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Admin API unreachable: " + err.Error()})
		return
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Unauthorized", "authFailed": true})
		return
	}
	w.WriteHeader(status)
	w.Write(body)
}

func (h *HTTPHandler) handleAdminNamespaces(w http.ResponseWriter, r *http.Request) {
	serviceURL := r.URL.Query().Get("serviceUrl")
	tenant := r.URL.Query().Get("tenant")
	token := r.URL.Query().Get("token")

	w.Header().Set("Content-Type", "application/json")

	if serviceURL == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "serviceUrl is required"})
		return
	}
	if tenant == "" {
		tenant = "public"
	}

	bases, err := adminHTTPBases(serviceURL)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}

	body, status, err := adminRequest(bases, token, "/admin/v2/namespaces/"+tenant)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Admin API unreachable: " + err.Error()})
		return
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "Unauthorized", "authFailed": true})
		return
	}
	w.WriteHeader(status)
	w.Write(body)
}

func (h *HTTPHandler) handleAdminCheckPermissions(w http.ResponseWriter, r *http.Request) {
	serviceURL := r.URL.Query().Get("serviceUrl")
	namespace := r.URL.Query().Get("namespace")
	token := r.URL.Query().Get("token")

	w.Header().Set("Content-Type", "application/json")

	if serviceURL == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": "serviceUrl is required"})
		return
	}
	if namespace == "" {
		namespace = "public/default"
	}

	bases, err := adminHTTPBases(serviceURL)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": err.Error()})
		return
	}

	type checkResult struct {
		Endpoint string `json:"endpoint"`
		URL      string `json:"url"`
		Status   int    `json:"status"`
		OK       bool   `json:"ok"`
		Error    string `json:"error,omitempty"`
	}

	// Determine which base URL actually responds
	resolvedBase := bases[0]
	for _, b := range bases {
		_, s, e := adminRequest([]string{b}, token, "/admin/v2/clusters")
		if e == nil && s != 0 {
			resolvedBase = b
			break
		}
	}

	probes := []struct {
		label string
		path  string
	}{
		{"List clusters", "/admin/v2/clusters"},
		{"List tenants", "/admin/v2/tenants"},
		{"List namespaces (public)", "/admin/v2/namespaces/public"},
		{"List persistent topics (" + namespace + ")", "/admin/v2/persistent/" + namespace},
		{"List non-persistent topics (" + namespace + ")", "/admin/v2/non-persistent/" + namespace},
	}

	results := make([]checkResult, 0, len(probes))
	for _, p := range probes {
		fullURL := resolvedBase + p.path
		body, status, reqErr := adminRequest([]string{resolvedBase}, token, p.path)
		res := checkResult{
			Endpoint: p.label,
			URL:      fullURL,
			Status:   status,
			OK:       status == http.StatusOK,
		}
		if reqErr != nil {
			res.Error = reqErr.Error()
		} else if status != http.StatusOK {
			// Include a snippet of the response body so the caller can see the reason
			snippet := strings.TrimSpace(string(body))
			if len(snippet) > 200 {
				snippet = snippet[:200] + "…"
			}
			res.Error = snippet
		}
		results = append(results, res)
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"resolvedAdminBase": resolvedBase,
		"checks":            results,
	})
}

// topicToAdminPath converts a topic URL to an admin API path with the given suffix.
// e.g. persistent://tenant/ns/topic, "stats" → /admin/v2/persistent/tenant/ns/topic/stats
func topicToAdminPath(topic, suffix string) string {
	scheme := "persistent"
	if strings.HasPrefix(topic, "non-persistent://") {
		scheme = "non-persistent"
	}
	topic = strings.TrimPrefix(topic, "persistent://")
	topic = strings.TrimPrefix(topic, "non-persistent://")
	return fmt.Sprintf("/admin/v2/%s/%s/%s", scheme, topic, suffix)
}

// writeSSEEvent writes a Server-Sent Event to the response writer
func writeSSEEvent(w http.ResponseWriter, eventType string, data interface{}) error {
	// Write event type
	if _, err := io.WriteString(w, "event: "+eventType+"\n"); err != nil {
		return err
	}

	// Write data as JSON
	jsonData, err := json.Marshal(data)
	if err != nil {
		return err
	}

	if _, err := io.WriteString(w, "data: "+string(jsonData)+"\n\n"); err != nil {
		return err
	}

	// Flush the response
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}

	return nil
}
