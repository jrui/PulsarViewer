// Package integration contains end-to-end tests that require a running Pulsar
// instance and exercise all PulsarViewer API surfaces.
//
// Run with: go test -tags=integration -v ./internal/integration/...
//
// Environment variables:
//
//	PULSAR_SERVICE_URL  – Pulsar broker URL   (default: pulsar://localhost:6650)
//	PV_BASE_URL         – PulsarViewer API URL (default: http://localhost:3000)
package integration

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func pulsarURL(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("PULSAR_SERVICE_URL"); v != "" {
		return v
	}
	return "pulsar://localhost:6650"
}

func baseURL(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("PV_BASE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://localhost:3000"
}

func jsonPost(t *testing.T, url string, body interface{}) *http.Response {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	return resp
}

func jsonGet(t *testing.T, url string) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	return resp
}

func readJSON(t *testing.T, resp *http.Response) map[string]interface{} {
	t.Helper()
	defer resp.Body.Close()
	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return result
}

func requireStatus(t *testing.T, resp *http.Response, expected int) {
	t.Helper()
	if resp.StatusCode != expected {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("expected HTTP %d, got %d: %s", expected, resp.StatusCode, string(body))
	}
}

const testTopic = "persistent://public/default/pv-integration-test"
const testSubscription = "pv-test-sub"

// startBackend launches the PulsarViewer Go backend as a subprocess and waits
// for the health endpoint to respond. Returns a cancel func to kill it.
func startBackend(t *testing.T) context.CancelFunc {
	t.Helper()

	// If the backend is already running (e.g. started externally), skip.
	resp, err := http.Get(baseURL(t) + "/health")
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode == 200 {
			t.Log("Backend already running, skipping subprocess launch")
			return func() {}
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "go", "run", "./cmd/main.go")
	cmd.Dir = findBackendDir(t)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatalf("start backend: %v", err)
	}

	// Wait for health endpoint
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(baseURL(t) + "/health")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				t.Log("Backend started successfully")
				return func() {
					cancel()
					_ = cmd.Wait()
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	cancel()
	_ = cmd.Wait()
	t.Fatal("backend did not become healthy within 30s")
	return nil
}

func findBackendDir(t *testing.T) string {
	t.Helper()
	candidates := []string{
		"../../",        // from internal/integration/
		"src/backend/",  // from repo root
		".",
	}
	for _, c := range candidates {
		if _, err := os.Stat(c + "cmd/main.go"); err == nil {
			return c
		}
	}
	t.Fatal("could not find backend directory with cmd/main.go")
	return ""
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestHealthEndpoint(t *testing.T) {
	stop := startBackend(t)
	defer stop()

	resp := jsonGet(t, baseURL(t)+"/health")
	requireStatus(t, resp, 200)
	data := readJSON(t, resp)
	if data["status"] != "ok" {
		t.Fatalf("expected status=ok, got %v", data["status"])
	}
}

func TestStaticFrontendServed(t *testing.T) {
	stop := startBackend(t)
	defer stop()

	resp := jsonGet(t, baseURL(t)+"/")
	requireStatus(t, resp, 200)
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	requiredElements := []string{
		"Pulsar Viewer",
		"connection-panel",
		"tab-consumer",
		"tab-producer",
		"tab-management",
		"proto-panel",
		"sendPayload",
		"templates-list",
	}
	for _, elem := range requiredElements {
		if !strings.Contains(html, elem) {
			t.Errorf("index.html missing expected element: %q", elem)
		}
	}
}

func TestProducerSendAndConsumerReceive(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)
	svcURL := pulsarURL(t)

	// 1. Send a message via the producer API
	payload := `{"integration":"test","ts":` + fmt.Sprintf("%d", time.Now().UnixMilli()) + `}`
	sendResp := jsonPost(t, base+"/api/send", map[string]interface{}{
		"serviceUrl": svcURL,
		"topic":      testTopic,
		"payload":    payload,
		"key":        "test-key",
	})
	requireStatus(t, sendResp, 200)
	sendData := readJSON(t, sendResp)
	if sendData["ok"] != true {
		t.Fatalf("send failed: %v", sendData)
	}
	msgID, _ := sendData["messageId"].(string)
	if msgID == "" {
		t.Fatal("send returned empty messageId")
	}
	t.Logf("Sent message: %s", msgID)

	// 2. Start an SSE consumer stream
	streamURL := fmt.Sprintf("%s/api/stream?serviceUrl=%s&topic=%s&subscription=%s&subscriptionType=Exclusive&initialPosition=earliest",
		base, svcURL, testTopic, testSubscription)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, "GET", streamURL, nil)
	client := &http.Client{}
	streamResp, err := client.Do(req)
	if err != nil {
		t.Fatalf("stream request: %v", err)
	}
	defer streamResp.Body.Close()

	if streamResp.StatusCode != 200 {
		body, _ := io.ReadAll(streamResp.Body)
		t.Fatalf("stream returned %d: %s", streamResp.StatusCode, string(body))
	}

	// 3. Read SSE events until we see the message or timeout
	scanner := bufio.NewScanner(streamResp.Body)
	foundMessage := false
	gotStats := false
	gotInfo := false

	for scanner.Scan() {
		line := scanner.Text()

		if strings.HasPrefix(line, "event: info") {
			gotInfo = true
		}
		if strings.HasPrefix(line, "event: stats") {
			gotStats = true
		}

		if strings.HasPrefix(line, "data: ") {
			data := line[6:]
			var evt map[string]interface{}
			if err := json.Unmarshal([]byte(data), &evt); err != nil {
				continue
			}

			// Check stats for message count
			if total, ok := evt["totalMessages"]; ok {
				if totalFloat, ok := total.(float64); ok && totalFloat > 0 {
					t.Logf("Stats: %v total messages", totalFloat)
				}
			}
		}

		if foundMessage && gotStats && gotInfo {
			break
		}

		select {
		case <-ctx.Done():
			break
		default:
		}
		if ctx.Err() != nil {
			break
		}
	}

	if !gotInfo {
		t.Error("never received an 'info' SSE event from the stream")
	}
	if !gotStats {
		t.Error("never received a 'stats' SSE event from the stream")
	}

	// 4. Verify messages can be fetched via the paginated API
	cancel() // close stream so /api/disconnect can clear

	// Small delay to let the stream's background consumer buffer at least 1 message
	time.Sleep(1 * time.Second)

	msgsResp := jsonGet(t, base+"/api/messages?page=0&pageSize=50")
	requireStatus(t, msgsResp, 200)
	msgsData := readJSON(t, msgsResp)

	totalMessages, _ := msgsData["totalMessages"].(float64)
	t.Logf("GET /api/messages: totalMessages=%v", totalMessages)

	// 5. Clean up
	clearResp := jsonPost(t, base+"/api/clear", nil)
	requireStatus(t, clearResp, 200)
	disconnectResp := jsonPost(t, base+"/api/disconnect", nil)
	requireStatus(t, disconnectResp, 200)
}

func TestSearchAPI(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)
	svcURL := pulsarURL(t)

	// Send a few messages with distinct payloads
	for i := 0; i < 3; i++ {
		payload := fmt.Sprintf(`{"search_test":true,"index":%d,"marker":"xyzzy_%d"}`, i, i)
		resp := jsonPost(t, base+"/api/send", map[string]interface{}{
			"serviceUrl": svcURL,
			"topic":      testTopic,
			"payload":    payload,
			"key":        fmt.Sprintf("search-key-%d", i),
		})
		requireStatus(t, resp, 200)
		resp.Body.Close()
	}

	// Start a stream to ingest messages, then stop it
	streamURL := fmt.Sprintf("%s/api/stream?serviceUrl=%s&topic=%s&subscription=%s-search&subscriptionType=Exclusive&initialPosition=earliest",
		base, svcURL, testTopic, testSubscription)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	req, _ := http.NewRequestWithContext(ctx, "GET", streamURL, nil)
	streamResp, err := http.Get(req.URL.String())
	if err != nil {
		cancel()
		t.Fatalf("stream: %v", err)
	}

	// Let it ingest for a few seconds
	time.Sleep(5 * time.Second)
	cancel()
	streamResp.Body.Close()

	// Now search
	searchResp := jsonGet(t, base+"/api/search?q=xyzzy&pageSize=50")
	requireStatus(t, searchResp, 200)
	searchData := readJSON(t, searchResp)
	t.Logf("Search results: totalMessages=%v", searchData["totalMessages"])

	// Clean up
	jsonPost(t, base+"/api/clear", nil).Body.Close()
	jsonPost(t, base+"/api/disconnect", nil).Body.Close()
}

func TestExportCSV(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)

	resp := jsonGet(t, base+"/api/export")
	requireStatus(t, resp, 200)
	defer resp.Body.Close()

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "text/csv") {
		t.Errorf("export Content-Type = %q, want text/csv", ct)
	}

	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "msg_timestamp") {
		t.Error("CSV export missing header row")
	}
}

func TestImportCSV(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)
	svcURL := pulsarURL(t)

	csvContent := "msg_timestamp,data\n2024-01-01T00:00:00Z,\"{\"\"imported\"\":true}\"\n2024-01-01T00:00:01Z,\"{\"\"imported\"\":true,\"\"row\"\":2}\"\n"

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	writer.WriteField("serviceUrl", svcURL)
	writer.WriteField("topic", testTopic)

	part, _ := writer.CreateFormFile("file", "test.csv")
	part.Write([]byte(csvContent))
	writer.Close()

	resp, err := http.Post(base+"/api/import", writer.FormDataContentType(), &buf)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	defer resp.Body.Close()
	requireStatus(t, resp, 200)

	// Read SSE progress events
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"done":true`) {
		t.Errorf("import response did not contain done event: %s", string(body))
	}
}

func TestManagementTopicList(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)
	svcURL := pulsarURL(t)

	// Ensure at least one topic exists by sending a message
	sendResp := jsonPost(t, base+"/api/send", map[string]interface{}{
		"serviceUrl": svcURL,
		"topic":      testTopic,
		"payload":    `{"ensure_topic":true}`,
	})
	requireStatus(t, sendResp, 200)
	sendResp.Body.Close()

	// List topics
	resp := jsonGet(t, fmt.Sprintf("%s/api/admin/topics?serviceUrl=%s&namespace=public/default", base, svcURL))
	requireStatus(t, resp, 200)
	data := readJSON(t, resp)

	topics, ok := data["topics"].([]interface{})
	if !ok {
		t.Fatalf("expected topics array, got %T", data["topics"])
	}

	found := false
	for _, topic := range topics {
		if strings.Contains(topic.(string), "pv-integration-test") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("test topic not found in topic list: %v", topics)
	}
}

func TestManagementTopicStats(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)
	svcURL := pulsarURL(t)

	resp := jsonGet(t, fmt.Sprintf("%s/api/admin/topic-stats?serviceUrl=%s&topic=%s", base, svcURL, testTopic))
	requireStatus(t, resp, 200)
	data := readJSON(t, resp)

	// Verify key stats fields exist
	for _, field := range []string{"msgRateIn", "msgRateOut", "storageSize"} {
		if _, ok := data[field]; !ok {
			t.Errorf("topic stats missing field: %s", field)
		}
	}
}

func TestManagementCheckPermissions(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)
	svcURL := pulsarURL(t)

	resp := jsonGet(t, fmt.Sprintf("%s/api/admin/check-permissions?serviceUrl=%s&namespace=public/default", base, svcURL))
	requireStatus(t, resp, 200)
	data := readJSON(t, resp)

	if _, ok := data["resolvedAdminBase"]; !ok {
		t.Error("check-permissions missing resolvedAdminBase")
	}
	checks, ok := data["checks"].([]interface{})
	if !ok || len(checks) == 0 {
		t.Error("check-permissions returned no checks")
	}

	for _, check := range checks {
		c := check.(map[string]interface{})
		t.Logf("Permission check: %s -> status=%v ok=%v", c["endpoint"], c["status"], c["ok"])
	}
}

func TestProtobufRegisterDecodeEncode(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)

	protoSource := `
syntax = "proto3";
package test;

message Person {
  string name = 1;
  int32 age = 2;
  string email = 3;
}
`

	// 1. Register schema
	regResp := jsonPost(t, base+"/api/proto/register", map[string]interface{}{
		"source":      protoSource,
		"messageType": "test.Person",
	})
	requireStatus(t, regResp, 200)
	regData := readJSON(t, regResp)

	if regData["ok"] != true {
		t.Fatalf("proto register failed: %v", regData)
	}
	if regData["selected"] != "test.Person" {
		t.Errorf("expected selected=test.Person, got %v", regData["selected"])
	}

	types, ok := regData["messageTypes"].([]interface{})
	if !ok || len(types) == 0 {
		t.Error("messageTypes should not be empty")
	}

	// 2. Check status
	statusResp := jsonGet(t, base+"/api/proto/status")
	requireStatus(t, statusResp, 200)
	statusData := readJSON(t, statusResp)

	if statusData["active"] != true {
		t.Error("proto should be active after register")
	}
	if statusData["messageType"] != "test.Person" {
		t.Errorf("expected messageType=test.Person, got %v", statusData["messageType"])
	}

	// 3. Encode JSON -> protobuf
	encResp := jsonPost(t, base+"/api/proto/encode", map[string]interface{}{
		"json": map[string]interface{}{
			"name":  "Alice",
			"age":   30,
			"email": "alice@example.com",
		},
	})
	requireStatus(t, encResp, 200)
	encData := readJSON(t, encResp)

	if encData["ok"] != true {
		t.Fatalf("proto encode failed: %v", encData)
	}
	b64, ok := encData["base64"].(string)
	if !ok || b64 == "" {
		t.Fatal("encode returned empty base64")
	}
	t.Logf("Encoded base64: %s", b64)

	// 4. Decode protobuf -> JSON
	decResp := jsonPost(t, base+"/api/proto/decode", map[string]interface{}{
		"data": b64,
	})
	requireStatus(t, decResp, 200)
	decData := readJSON(t, decResp)

	if decData["ok"] != true {
		t.Fatalf("proto decode failed: %v", decData)
	}
	jsonResult, ok := decData["json"].(map[string]interface{})
	if !ok {
		t.Fatalf("decoded json is not an object: %T", decData["json"])
	}
	if jsonResult["name"] != "Alice" {
		t.Errorf("decoded name=%v, want Alice", jsonResult["name"])
	}
	t.Logf("Decoded: %v", jsonResult)

	// 5. Generate template
	tmplResp := jsonGet(t, base+"/api/proto/template")
	requireStatus(t, tmplResp, 200)
	tmplData := readJSON(t, tmplResp)

	if tmplData["ok"] != true {
		t.Fatalf("proto template failed: %v", tmplData)
	}
	tmpl, ok := tmplData["template"].(map[string]interface{})
	if !ok {
		t.Fatalf("template is not an object: %T", tmplData["template"])
	}
	for _, field := range []string{"name", "age", "email"} {
		if _, exists := tmpl[field]; !exists {
			t.Errorf("template missing field: %s", field)
		}
	}

	// 6. Clear schema
	clearResp := jsonPost(t, base+"/api/proto/clear", nil)
	requireStatus(t, clearResp, 200)

	// Verify cleared
	statusResp2 := jsonGet(t, base+"/api/proto/status")
	requireStatus(t, statusResp2, 200)
	statusData2 := readJSON(t, statusResp2)
	if statusData2["active"] != false {
		t.Error("proto should be inactive after clear")
	}
}

func TestProtobufProducerIntegration(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)
	svcURL := pulsarURL(t)

	protoSource := `
syntax = "proto3";
package test;

message Event {
  string type = 1;
  int64 timestamp = 2;
  string data = 3;
}
`

	// Register schema
	regResp := jsonPost(t, base+"/api/proto/register", map[string]interface{}{
		"source":      protoSource,
		"messageType": "test.Event",
	})
	requireStatus(t, regResp, 200)
	regResp.Body.Close()

	// Send with protobuf encoding
	payload := fmt.Sprintf(`{"type":"test_event","timestamp":%d,"data":"hello protobuf"}`, time.Now().UnixMilli())
	sendResp := jsonPost(t, base+"/api/send", map[string]interface{}{
		"serviceUrl":  svcURL,
		"topic":       testTopic + "-proto",
		"payload":     payload,
		"key":         "proto-key",
		"useProtobuf": true,
	})
	requireStatus(t, sendResp, 200)
	sendData := readJSON(t, sendResp)
	if sendData["ok"] != true {
		t.Fatalf("protobuf send failed: %v", sendData)
	}
	t.Logf("Sent protobuf message: %v", sendData["messageId"])

	// Clear schema for next tests
	jsonPost(t, base+"/api/proto/clear", nil).Body.Close()
}

func TestStatsEndpoint(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)

	resp := jsonGet(t, base+"/api/stats")
	requireStatus(t, resp, 200)
	data := readJSON(t, resp)

	for _, field := range []string{"totalMessages", "isBuffering", "connections", "timestamp"} {
		if _, ok := data[field]; !ok {
			t.Errorf("stats missing field: %s", field)
		}
	}
}

func TestClearMessages(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)

	resp := jsonPost(t, base+"/api/clear", nil)
	requireStatus(t, resp, 200)
	data := readJSON(t, resp)
	if data["ok"] != true {
		t.Fatalf("clear failed: %v", data)
	}

	// Verify store is empty
	msgsResp := jsonGet(t, base+"/api/messages?page=0&pageSize=10")
	requireStatus(t, msgsResp, 200)
	msgsData := readJSON(t, msgsResp)
	if total, _ := msgsData["totalMessages"].(float64); total != 0 {
		t.Errorf("expected 0 messages after clear, got %v", total)
	}
}

func TestDisconnectEndpoint(t *testing.T) {
	stop := startBackend(t)
	defer stop()
	base := baseURL(t)

	resp := jsonPost(t, base+"/api/disconnect", nil)
	requireStatus(t, resp, 200)
	data := readJSON(t, resp)
	if data["ok"] != true {
		t.Fatalf("disconnect failed: %v", data)
	}
}
