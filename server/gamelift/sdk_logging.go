package main

import (
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"regexp"
	"strings"

	"github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/common"
	sdk "github.com/amazon-gamelift/amazon-gamelift-servers-go-server-sdk/v5/server"
)

var diagnosticURL = regexp.MustCompile(`(?:https?|wss?)://[^\s"<>]+`)

// The SDK's default logger opens ./logs and calls os.Exit if the working
// directory is not writable. Use the already-open, private host log instead.
// SDK debug frames may contain authentication and fleet credentials.
type privateSDKLogger struct {
	output  *log.Logger
	secrets []string
}

func newPrivateSDKLogger(output *log.Logger) *privateSDKLogger {
	l := &privateSDKLogger{output: output}
	for _, key := range []string{common.EnvironmentKeyAuthToken, common.EnvironmentKeyAccessKey, common.EnvironmentKeySecretKey, common.EnvironmentKeySessionToken} {
		if value := os.Getenv(key); value != "" {
			l.secrets = append(l.secrets, value)
		}
	}
	return l
}
func (*privateSDKLogger) Debugf(string, ...any) {}
func (l *privateSDKLogger) Warnf(pattern string, args ...any) {
	l.output.Printf("GameLift SDK warning: %s", l.redact(fmt.Sprintf(pattern, args...)))
}
func (l *privateSDKLogger) Errorf(pattern string, args ...any) {
	l.output.Printf("GameLift SDK error: %s", l.redact(fmt.Sprintf(pattern, args...)))
}
func (l *privateSDKLogger) redact(message string) string {
	for _, secret := range l.secrets {
		message = strings.ReplaceAll(message, secret, "[redacted]")
	}
	return diagnosticURL.ReplaceAllStringFunc(message, func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil {
			return "[redacted URL]"
		}
		u.User, u.RawQuery, u.Fragment, u.ForceQuery = nil, "", "", false
		return u.String()
	})
}
func initializeManagedSDK() error {
	l := newPrivateSDKLogger(log.Default())
	sdk.SetLoggerInterface(l)
	if err := sdk.InitSDKFromEnvironment(); err != nil {
		return errors.New(l.redact(err.Error()))
	}
	return nil
}
