<?php
/**
 * Test wtyczki bez WordPressa: atrapy funkcji WP + asercje. Uruchom: php tests/test-plugin.php
 */
define( 'ABSPATH', __DIR__ );
$GLOBALS['_opts'] = array(); $GLOBALS['_scripts'] = array(); $GLOBALS['_inline'] = array(); $GLOBALS['_caps'] = false;
$GLOBALS['_errors'] = array();

function add_shortcode( $t, $c ) {} function add_action() {} function add_filter() {}
function plugin_basename( $f ) { return basename( $f ); }
function get_option( $k, $d = false ) { return $GLOBALS['_opts'][ $k ] ?? $d; }
function wp_parse_args( $a, $d ) { return array_merge( $d, $a ); }
function untrailingslashit( $s ) { return rtrim( $s, '/\\' ); }
function wp_http_validate_url( $u ) { return filter_var( $u, FILTER_VALIDATE_URL ) ? $u : false; }
function shortcode_atts( $pairs, $atts ) { $atts = (array) $atts; $o = array(); foreach ( $pairs as $k => $v ) { $o[ $k ] = array_key_exists( $k, $atts ) ? $atts[ $k ] : $v; } return $o; }
function current_user_can( $c ) { return $GLOBALS['_caps']; }
function get_privacy_policy_url() { return 'https://pilankapilatestczew.pl/polityka-prywatnosci/'; }
function esc_url_raw( $u, $p = null ) { $u = filter_var( $u, FILTER_SANITIZE_URL ); if ( ! preg_match( '#^https?://#i', $u ) ) { return ''; } if ( $p && ! in_array( strtolower( parse_url( $u, PHP_URL_SCHEME ) ), $p, true ) ) { return ''; } return $u; }
function esc_url( $u ) { return htmlspecialchars( esc_url_raw( $u ), ENT_QUOTES ); }
function esc_attr( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES, 'UTF-8' ); }
function esc_html( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES, 'UTF-8' ); }
function sanitize_text_field( $s ) { return trim( preg_replace( '/[\r\n\t ]+/', ' ', strip_tags( (string) $s ) ) ); }
function add_settings_error( $a, $b, $m ) { $GLOBALS['_errors'][] = $m; }
function wp_script_is( $h, $l ) { return isset( $GLOBALS['_scripts'][ $h ] ); }
function wp_enqueue_script( $h, $src, $deps, $ver, $args ) { $GLOBALS['_scripts'][ $h ] = compact( 'src', 'args' ); }
function wp_add_inline_script( $h, $js, $pos ) { $GLOBALS['_inline'][] = $js; }

require dirname( __DIR__ ) . '/pilanka-booking/pilanka-booking.php';

$fails = 0;
function check( $cond, $msg ) { global $fails; echo ( $cond ? "  ok   " : "  FAIL " ) . $msg . "\n"; if ( ! $cond ) { $fails++; } }

echo "Bez konfiguracji:\n";
check( '' === Pilanka_Booking::shortcode( array() ), 'gość nie widzi nic' );
$GLOBALS['_caps'] = true;
check( false !== strpos( Pilanka_Booking::shortcode( array() ), 'uzupełnij adres serwera' ), 'admin widzi podpowiedź' );
check( empty( $GLOBALS['_scripts'] ), 'skrypt nie jest ładowany' );

echo "Sanityzacja ustawień:\n";
$s = Pilanka_Booking::sanitize( array(
	'server_url' => ' https://rezerwacje.pilankapilatestczew.pl/ ',
	'contact_phone' => '+48 600 000 000<script>',
	'title' => '<b>Umów</b> trening',
	'theme' => 'evil',
	'track_events' => '1',
) );
check( 0 === Pilanka_Booking::sanitize( array() )['track_events'], 'odznaczony checkbox analityki → 0' );
check( 'https://rezerwacje.pilankapilatestczew.pl' === $s['server_url'], 'adres bez ukośnika: ' . $s['server_url'] );
check( '+48 600 000 000' === $s['contact_phone'], 'telefon oczyszczony: ' . $s['contact_phone'] );
check( 'Umów trening' === $s['title'], 'tytuł bez HTML' );
check( 'light' === $s['theme'], 'nieznany motyw → light' );
check( '' === Pilanka_Booking::sanitize( array( 'server_url' => 'http://example.com' ) )['server_url'] && count( $GLOBALS['_errors'] ) === 1, 'http:// odrzucony z komunikatem' );
check( 'http://localhost:8080' === Pilanka_Booking::sanitize( array( 'server_url' => 'http://localhost:8080' ) )['server_url'], 'http://localhost dozwolony (testy)' );
check( '' === Pilanka_Booking::sanitize( array( 'server_url' => 'javascript:alert(1)' ) )['server_url'], 'javascript: odrzucony' );

echo "Shortcode po konfiguracji:\n";
$GLOBALS['_opts']['pilanka_booking_settings'] = $s;
$GLOBALS['_caps'] = false;
$html = Pilanka_Booking::shortcode( array( 'title' => '"><script>alert(1)</script>', 'theme' => 'dark' ) );
echo '       ' . $html . "\n";
check( false === strpos( $html, '<script>' ), 'brak XSS przez atrybut title' );
check( false !== strpos( $html, 'data-pilanka-booking' ), 'element widgetu' );
check( false !== strpos( $html, 'data-api="https://rezerwacje.pilankapilatestczew.pl"' ), 'data-api' );
check( false !== strpos( $html, 'data-theme="dark"' ), 'motyw z atrybutu shortcode' );
check( false !== strpos( $html, 'data-privacy-url="https://pilankapilatestczew.pl/polityka-prywatnosci/"' ), 'polityka prywatności z WP' );
check( false !== strpos( $html, 'href="tel:+48600000000"' ), 'link tel: w noscript' );
check( false !== strpos( $html, 'id="rezerwacja"' ), 'kotwica #rezerwacja' );
check( 'https://rezerwacje.pilankapilatestczew.pl/widget.js' === $GLOBALS['_scripts']['pilanka-booking-widget']['src'], 'skrypt widgetu z serwera' );
check( 'defer' === $GLOBALS['_scripts']['pilanka-booking-widget']['args']['strategy'], 'ładowanie defer' );
check( 1 === count( $GLOBALS['_inline'] ) && false !== strpos( $GLOBALS['_inline'][0], 'pilanka:booked' ), 'zdarzenie konwersji' );
$html2 = Pilanka_Booking::shortcode( array() );
check( false === strpos( $html2, 'id="rezerwacja"' ), 'drugi widget bez zduplikowanego id' );
check( 1 === count( $GLOBALS['_inline'] ), 'skrypt dodany tylko raz' );

echo $fails ? "\n$fails błędów\n" : "\nWszystko OK\n";
exit( $fails ? 1 : 0 );
