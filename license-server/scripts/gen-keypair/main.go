// Command gen-keypair prints a fresh Ed25519 keypair for entitlement-token
// signing (ADR-0026). Run it once per environment:
//
//	go run ./scripts/gen-keypair
//
// The SEED goes into LS as C3_LS_ED25519_PRIVATE_KEY (kept secret, PL-R12). The
// PUBLIC key is embedded in the c3 binary so it can verify tokens offline. The
// KID is the short key id carried in each token's payload, enabling rotation.
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"

	"github.com/sequencestream/code-creative-center/license-server/internal/token"
)

func main() {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		panic(err)
	}
	seed := priv.Seed()
	fmt.Printf("C3_LS_ED25519_PRIVATE_KEY (seed, secret): %s\n", base64.StdEncoding.EncodeToString(seed))
	fmt.Printf("public key (embed in c3):              %s\n", base64.StdEncoding.EncodeToString(pub))
	fmt.Printf("key id (kid):                          %s\n", token.KeyID(pub))
}
