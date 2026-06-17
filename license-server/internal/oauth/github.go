// Package oauth implements the GitHub OAuth web flow LS uses to identify the
// user during activation (PL-R9) and the admin in the back-office (PL-R11).
// GitHub is the only login provider for the MVP (ADR-0026). The OAuth client
// secret lives only in LS (PL-R12); c3 never sees it.
//
// Endpoints are fields on the Client so tests can point them at a local stub
// instead of github.com.
package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Default GitHub OAuth endpoints.
const (
	defaultAuthorizeURL = "https://github.com/login/oauth/authorize"
	defaultTokenURL     = "https://github.com/login/oauth/access_token"
	defaultUserURL      = "https://api.github.com/user"
)

// DefaultScopes is the minimal scope set: read the user's public profile. We do
// not request repo or write scopes — identity is all activation needs.
var DefaultScopes = []string{"read:user", "user:email"}

// User is the subset of the GitHub user we persist as a user identity.
type User struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Email string `json:"email"`
}

// Client performs the GitHub OAuth exchange. The zero value is unusable; build
// one with New so the endpoints and HTTP client default correctly.
type Client struct {
	ClientID     string
	ClientSecret string

	AuthorizeURL string
	TokenURL     string
	UserURL      string

	HTTP *http.Client
}

// New builds a Client with GitHub's production endpoints and a bounded HTTP
// client. Tests override the URLs and HTTP field directly.
func New(clientID, clientSecret string) *Client {
	return &Client{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		AuthorizeURL: defaultAuthorizeURL,
		TokenURL:     defaultTokenURL,
		UserURL:      defaultUserURL,
		HTTP:         &http.Client{Timeout: 15 * time.Second},
	}
}

// Configured reports whether the OAuth credentials are present. The activation
// surface returns a clear error rather than a broken redirect when they are not.
func (c *Client) Configured() bool {
	return c != nil && strings.TrimSpace(c.ClientID) != "" && strings.TrimSpace(c.ClientSecret) != ""
}

// AuthorizeURLFor builds the GitHub authorize URL to redirect the user's
// browser to. state binds the redirect back to a specific activation request
// (CSRF protection); redirectURI is the LS callback.
func (c *Client) AuthorizeURLFor(redirectURI, state string, scopes []string) string {
	if len(scopes) == 0 {
		scopes = DefaultScopes
	}
	q := url.Values{}
	q.Set("client_id", c.ClientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", strings.Join(scopes, " "))
	q.Set("state", state)
	q.Set("allow_signup", "true")
	return c.AuthorizeURL + "?" + q.Encode()
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

// Exchange swaps an authorization code for a GitHub access token.
func (c *Client) Exchange(ctx context.Context, code, redirectURI string) (string, error) {
	form := url.Values{}
	form.Set("client_id", c.ClientID)
	form.Set("client_secret", c.ClientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("oauth: token exchange: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("oauth: token exchange status %d", resp.StatusCode)
	}

	var parsed struct {
		AccessToken      string `json:"access_token"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("oauth: decode token response: %w", err)
	}
	if parsed.Error != "" {
		return "", fmt.Errorf("oauth: token error %q: %s", parsed.Error, parsed.ErrorDescription)
	}
	if parsed.AccessToken == "" {
		return "", fmt.Errorf("oauth: empty access token")
	}
	return parsed.AccessToken, nil
}

// FetchUser reads the authenticated user's identity using the access token.
func (c *Client) FetchUser(ctx context.Context, accessToken string) (User, error) {
	var u User
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.UserURL, nil)
	if err != nil {
		return u, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return u, fmt.Errorf("oauth: fetch user: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return u, fmt.Errorf("oauth: fetch user status %d", resp.StatusCode)
	}
	if err := json.Unmarshal(body, &u); err != nil {
		return u, fmt.Errorf("oauth: decode user: %w", err)
	}
	if u.ID == 0 || u.Login == "" {
		return u, fmt.Errorf("oauth: incomplete user identity")
	}
	return u, nil
}

// StateID extracts the activation-request id a state value was minted for. State
// is "<requestID>.<nonce>"; the nonce is opaque entropy bound at mint time.
func StateID(state string) (string, bool) {
	id, _, ok := strings.Cut(state, ".")
	if !ok || id == "" {
		return "", false
	}
	if _, err := strconv.ParseInt(id, 10, 64); err != nil {
		return "", false
	}
	return id, true
}
