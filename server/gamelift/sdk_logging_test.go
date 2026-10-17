package main

import (
	"bytes"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/common"
)

func TestPrivateSDKLoggerSuppressesProtocolFramesAndSecrets(t *testing.T) {
	keys := []string{common.EnvironmentKeyAuthToken, common.EnvironmentKeyAccessKey, common.EnvironmentKeySecretKey, common.EnvironmentKeySessionToken}
	for i, key := range keys {
		t.Setenv(key, fmt.Sprintf("sensitive-value-%d", i))
	}
	var output bytes.Buffer
	l := newPrivateSDKLogger(log.New(&output, "", 0))
	l.Debugf("received credentials %s", "private-debug-payload")
	if output.Len() != 0 {
		t.Fatal("SDK protocol debug frame reached the host log")
	}
	l.Warnf("connection interrupted: %s", "wss://private-user:private-password@example.test/connect?AuthToken=unknown-query-token#private-fragment")
	l.Errorf("authorization failed: %s %s %s %s", "sensitive-value-0", "sensitive-value-1", "sensitive-value-2", "sensitive-value-3")
	text := output.String()
	for _, forbidden := range []string{"private-", "unknown-query-token", "sensitive-value-", "AuthToken="} {
		if strings.Contains(text, forbidden) {
			t.Fatal("sensitive SDK diagnostic content was not redacted")
		}
	}
	if !strings.Contains(text, "connection interrupted: wss://example.test/connect") || !strings.Contains(text, "authorization failed: [redacted]") {
		t.Fatal("safe warning/error context was lost")
	}
}

func TestManagedSDKLoggingIgnoresWorkingDirectory(t *testing.T) {
	if os.Getenv("BOLTS_TEST_SDK_LOGGER") == "child" {
		// No GameLift environment is supplied. Real SDK validation must return
		// before network access; its default logger would instead exit on ./logs.
		err := initializeManagedSDK()
		if err == nil || !strings.Contains(err.Error(), "authorization strategy") {
			t.Fatalf("expected SDK parameter validation, got %v", err)
		}
		fmt.Println("SDK returned expected parameter validation")
		return
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0700) })
	cmd := exec.Command(os.Args[0], "-test.run=^TestManagedSDKLoggingIgnoresWorkingDirectory$")
	cmd.Dir = dir
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "GAMELIFT_") && !strings.HasPrefix(value, "BOLTS_TEST_SDK_LOGGER=") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env, "BOLTS_TEST_SDK_LOGGER=child")
	output, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "SDK returned expected parameter validation") {
		t.Fatalf("SDK logger must be injected before SDK initialization: %v %s", err, output)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatal("SDK startup wrote into its working directory")
	}
}
