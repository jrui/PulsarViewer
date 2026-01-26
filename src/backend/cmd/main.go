package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jrui/pulsarviewer/internal/pulsar"
	"github.com/jrui/pulsarviewer/internal/server"
	"github.com/jrui/pulsarviewer/internal/store"
	"google.golang.org/grpc"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting PulsarViewer...")

	// Initialize message store with 1 GB limit
	oneGBInBytes := int64(1024 * 1024 * 1024)
	messageStore := store.NewMessageStore(oneGBInBytes)

	// Initialize Pulsar client manager
	pulsarClient := pulsar.NewClientManager()
	defer pulsarClient.Close()

	// Create gRPC server with optimizations
	grpcServer := grpc.NewServer(
		grpc.MaxRecvMsgSize(100*1024*1024),
		grpc.MaxSendMsgSize(100*1024*1024),
		grpc.MaxConcurrentStreams(1000),
		grpc.ConnectionTimeout(30*time.Second),
	)

	// Create HTTP handler
	httpHandler := server.NewHTTPHandler(pulsarClient, messageStore)

	// Create HTTP server with optimizations
	httpServer := &http.Server{
		Addr:           ":3000",
		Handler:        httpHandler,
		ReadTimeout:    30 * time.Second,
		WriteTimeout:   30 * time.Second,
		IdleTimeout:    90 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}

	var wg sync.WaitGroup

	// Start gRPC listener
	wg.Add(1)
	go func() {
		defer wg.Done()
		grpcListener, err := net.Listen("tcp", ":50051")
		if err != nil {
			log.Fatalf("Failed to listen on gRPC port: %v", err)
		}
		log.Println("gRPC server listening on :50051")

		server.RegisterGRPCServer(grpcServer, pulsarClient, messageStore)

		if err := grpcServer.Serve(grpcListener); err != nil {
			log.Fatalf("gRPC server error: %v", err)
		}
	}()

	// Start HTTP server
	wg.Add(1)
	go func() {
		defer wg.Done()
		log.Println("HTTP server listening on :3000")
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("Shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	grpcServer.GracefulStop()
	httpServer.Shutdown(ctx)
	pulsarClient.Close()

	wg.Wait()
	log.Println("Shutdown complete")
}
