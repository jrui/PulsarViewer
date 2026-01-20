package server

import (
	"google.golang.org/grpc"
	"github.com/jrui/pulsarviewer/internal/pulsar"
	"github.com/jrui/pulsarviewer/internal/store"
)

// RegisterGRPCServer registers gRPC services
func RegisterGRPCServer(grpcServer *grpc.Server, pulsarClient *pulsar.ClientManager, messageStore *store.MessageStore) {
	// TODO: Add gRPC service implementations
	// This would require protobuf definitions
	// For now, we focus on HTTP + WebSocket which is more versatile for browser clients
}
