package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ErrNotFound means the save code (or the document under it) does not exist.
var ErrNotFound = errors.New("not found")

// Store is one app's SQLite database.
type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS codes (
	code       TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	last_seen  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS saves (
	code       TEXT NOT NULL REFERENCES codes(code) ON DELETE CASCADE,
	doc        TEXT NOT NULL,
	data       TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (code, doc)
);`

func OpenStore(file string) (*Store, error) {
	dsn := "file:" + file + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One writer at a time is all SQLite allows anyway; this keeps it from returning SQLITE_BUSY.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

var codeRE = regexp.MustCompile(`^[A-Z]{3,8}-[0-9]{4}$`)

func validCode(c string) bool { return codeRE.MatchString(c) }

// codeWords are short, friendly and hard to misread when a kid reads one out to a parent.
var codeWords = strings.Fields(`
	ACORN AMBER ANCHOR APPLE ARROW ASPEN AUTUMN BADGER BAMBOO BANJO BASIL BEACON BEAVER BERRY
	BISON BLAZE BREEZE BRAVE BUCKET BUTTON CACTUS CAMEL CANDLE CANYON CARROT CASTLE CEDAR CHERRY
	CHESS CLOVER COBALT COMET CORAL COUGAR COYOTE CRANE CRICKET CRYSTAL DAISY DELTA DINGO DOLPHIN
	DRAGON EAGLE EMBER FALCON FERN FIG FLINT FOREST FOSSIL FOX GALAXY GECKO GIANT GINGER GLACIER
	GOBLIN GRAPE GRAVEL GRIFFIN HARBOR HAWK HAZEL HERON HONEY HOPPER IGLOO IRIS IVORY JACKAL JADE
	JAGUAR JASPER JELLY JUNIPER KAYAK KETTLE KIWI KOALA LAGOON LANTERN LARCH LEMON LILAC LION LLAMA
	LOTUS LYNX MAGPIE MANGO MAPLE MARBLE MEADOW MESA MINT MOOSE MOSS NECTAR NIMBLE NUTMEG OAK OCEAN
	OLIVE ONYX ORBIT ORCA OTTER OWL PANDA PAPAYA PEBBLE PEPPER PICKLE PINE PIXEL PLUM POLAR PONY
	POPPY PRAIRIE PUFFIN QUARTZ QUILL RABBIT RADISH RAVEN REEF RIVER ROBIN ROCKET RUBY SAGE SALMON
	SAPPHIRE SATURN SEQUOIA SHERPA SILVER SPARROW SPROUT SQUID STORM SUMMIT SUNNY TALON TANGO
	THISTLE THUNDER TIGER TOPAZ TOUCAN TULIP TUNDRA TURTLE VELVET VIOLET VOYAGE WAFFLE WALNUT
	WALRUS WILLOW WIZARD WOMBAT YETI ZEBRA ZEPHYR`)

func randInt(n int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		panic(err)
	}
	return int(v.Int64())
}

// NewCode registers a fresh, unused save code.
func (s *Store) NewCode(ctx context.Context) (string, error) {
	now := time.Now().UnixMilli()
	for i := 0; i < 20; i++ {
		code := fmt.Sprintf("%s-%04d", codeWords[randInt(len(codeWords))], randInt(10000))
		res, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO codes (code, created_at, last_seen) VALUES (?, ?, ?)`, code, now, now)
		if err != nil {
			return "", err
		}
		if n, _ := res.RowsAffected(); n == 1 {
			return code, nil
		}
	}
	return "", errors.New("no free code after 20 tries")
}

func (s *Store) CodeExists(ctx context.Context, code string) (bool, error) {
	if !validCode(code) {
		return false, nil
	}
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM codes WHERE code = ?`, code).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) Get(ctx context.Context, code, doc string) ([]byte, error) {
	var data string
	err := s.db.QueryRowContext(ctx, `SELECT data FROM saves WHERE code = ? AND doc = ?`, code, doc).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return []byte(data), err
}

// Put stores a document under an existing code.
func (s *Store) Put(ctx context.Context, code, doc string, data []byte) error {
	now := time.Now().UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE codes SET last_seen = ? WHERE code = ?`, now, code)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO saves (code, doc, data, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (code, doc) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
		code, doc, string(data), now)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// Backup writes a consistent snapshot of the database to dst.
func (s *Store) Backup(ctx context.Context, dst string) error {
	_, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, dst)
	return err
}
