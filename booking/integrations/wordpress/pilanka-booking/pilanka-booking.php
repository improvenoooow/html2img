<?php
/**
 * Plugin Name:       Pilanka – Rezerwacje online
 * Description:       Osadza widget rezerwacji (Google Calendar + weryfikacja SMS). Użycie: shortcode [pilanka_rezerwacja].
 * Version:           1.0.0
 * Requires at least: 6.3
 * Requires PHP:      7.4
 * Author:            Pilanka Pilates Tczew
 * License:           GPL-2.0-or-later
 * Text Domain:       pilanka-booking
 *
 * Wtyczka nie zawiera logiki rezerwacji ani kluczy API – tylko wstawia widget z serwera rezerwacji.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Pilanka_Booking {

	const OPTION    = 'pilanka_booking_settings';
	const HANDLE    = 'pilanka-booking-widget';
	const SHORTCODE = 'pilanka_rezerwacja';

	/** @var int Liczba widgetów na bieżącej stronie (kotwica #rezerwacja tylko dla pierwszego). */
	private static $count = 0;

	public static function init() {
		add_shortcode( self::SHORTCODE, array( __CLASS__, 'shortcode' ) );
		add_action( 'admin_menu', array( __CLASS__, 'admin_menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_filter( 'wp_resource_hints', array( __CLASS__, 'resource_hints' ), 10, 2 );
		add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), array( __CLASS__, 'action_links' ) );
	}

	public static function defaults() {
		return array(
			'server_url'    => '',
			'contact_phone' => '',
			'privacy_url'   => '',
			'title'         => '',
			'subtitle'      => '',
			'theme'         => 'light',
			'track_events'  => 1,
		);
	}

	public static function settings() {
		$saved = get_option( self::OPTION, array() );
		return wp_parse_args( is_array( $saved ) ? $saved : array(), self::defaults() );
	}

	/** Adres serwera rezerwacji bez końcowego ukośnika; pusty, jeśli nie skonfigurowano. */
	private static function server_url() {
		$url = untrailingslashit( (string) self::settings()['server_url'] );
		return ( $url && wp_http_validate_url( $url ) ) ? $url : '';
	}

	// ------------------------------------------------------------------ front

	/**
	 * [pilanka_rezerwacja title="…" subtitle="…" theme="light|dark|auto" phone="…"]
	 */
	public static function shortcode( $atts ) {
		$s    = self::settings();
		$atts = shortcode_atts(
			array(
				'title'    => $s['title'],
				'subtitle' => $s['subtitle'],
				'theme'    => $s['theme'],
				'phone'    => $s['contact_phone'],
			),
			$atts,
			self::SHORTCODE
		);

		$server = self::server_url();
		if ( '' === $server ) {
			return current_user_can( 'manage_options' )
				? '<p><strong>Rezerwacje:</strong> uzupełnij adres serwera w Ustawienia → Rezerwacje Pilanka.</p>'
				: '';
		}

		self::$count++;
		self::enqueue( $server, ! empty( $s['track_events'] ) );

		$privacy = $s['privacy_url'] ? $s['privacy_url'] : get_privacy_policy_url();
		$theme   = in_array( $atts['theme'], array( 'light', 'dark', 'auto' ), true ) ? $atts['theme'] : 'light';

		$attrs = array(
			'data-pilanka-booking' => '',
			'data-theme'           => $theme,
			'data-api'             => $server,
		);
		if ( '' !== $atts['title'] ) {
			$attrs['data-title'] = $atts['title'];
		}
		if ( '' !== $atts['subtitle'] ) {
			$attrs['data-subtitle'] = $atts['subtitle'];
		}
		if ( '' !== $atts['phone'] ) {
			$attrs['data-contact-phone'] = $atts['phone'];
		}
		if ( $privacy ) {
			$attrs['data-privacy-url'] = esc_url_raw( $privacy );
		}

		$html = '<div' . ( 1 === self::$count ? ' id="rezerwacja"' : '' ) . ' class="pilanka-booking"';
		foreach ( $attrs as $name => $value ) {
			$html .= ' ' . $name . ( '' === $value ? '' : '="' . esc_attr( $value ) . '"' );
		}
		$html .= '>';
		// Treść widoczna tylko bez JavaScriptu (widget zastępuje ją po załadowaniu).
		$html .= '<noscript>Rezerwacja online wymaga włączonego JavaScriptu.';
		if ( '' !== $atts['phone'] ) {
			$tel   = preg_replace( '/[^\d+]/', '', $atts['phone'] );
			$html .= ' Możesz też zadzwonić: <a href="' . esc_attr( 'tel:' . $tel ) . '">' . esc_html( $atts['phone'] ) . '</a>.';
		}
		$html .= '</noscript></div>';

		return $html;
	}

	private static function enqueue( $server, $track_events ) {
		if ( wp_script_is( self::HANDLE, 'enqueued' ) ) {
			return;
		}
		wp_enqueue_script(
			self::HANDLE,
			$server . '/widget.js',
			array(),
			null, // wersjonowanie robi serwer rezerwacji (Cache-Control)
			array(
				'in_footer' => true,
				'strategy'  => 'defer',
			)
		);
		if ( $track_events ) {
			// Konwersja po potwierdzonej rezerwacji – działa, jeśli na stronie jest GA4 (gtag) lub Meta Pixel.
			wp_add_inline_script(
				self::HANDLE,
				"document.addEventListener('pilanka:booked',function(e){var d=e.detail||{};" .
				"if(window.gtag){gtag('event','booking_confirmed',{booking_id:d.bookingId});}" .
				"if(window.fbq){fbq('track','Schedule');}" .
				"if(window.dataLayer){dataLayer.push({event:'pilanka_booking_confirmed',booking_id:d.bookingId});}});",
				'before'
			);
		}
	}

	/** preconnect do serwera rezerwacji – szybsze wczytanie kalendarza. */
	public static function resource_hints( $urls, $relation ) {
		if ( 'preconnect' === $relation && is_singular() ) {
			$post   = get_post();
			$server = self::server_url();
			if ( $server && $post && has_shortcode( (string) $post->post_content, self::SHORTCODE ) ) {
				$urls[] = array(
					'href'        => $server,
					'crossorigin' => 'anonymous',
				);
			}
		}
		return $urls;
	}

	// ------------------------------------------------------------------ admin

	public static function action_links( $links ) {
		array_unshift(
			$links,
			'<a href="' . esc_url( admin_url( 'options-general.php?page=pilanka-booking' ) ) . '">Ustawienia</a>'
		);
		return $links;
	}

	public static function admin_menu() {
		add_options_page( 'Rezerwacje Pilanka', 'Rezerwacje Pilanka', 'manage_options', 'pilanka-booking', array( __CLASS__, 'render_settings_page' ) );
	}

	public static function register_settings() {
		register_setting(
			'pilanka_booking',
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'default'           => self::defaults(),
			)
		);
	}

	public static function sanitize( $input ) {
		$input = is_array( $input ) ? $input : array();
		$out   = self::defaults();

		$url = isset( $input['server_url'] ) ? esc_url_raw( trim( (string) $input['server_url'] ), array( 'https', 'http' ) ) : '';
		if ( $url && 0 !== strpos( $url, 'https://' ) && ! preg_match( '#^http://(localhost|127\.0\.0\.1)(:\d+)?#', $url ) ) {
			add_settings_error( self::OPTION, 'https', 'Adres serwera rezerwacji musi zaczynać się od https://' );
			$url = '';
		}
		$out['server_url']    = untrailingslashit( $url );
		$out['contact_phone'] = isset( $input['contact_phone'] ) ? preg_replace( '/[^\d+ ()-]/', '', sanitize_text_field( $input['contact_phone'] ) ) : '';
		$out['privacy_url']   = isset( $input['privacy_url'] ) ? esc_url_raw( trim( (string) $input['privacy_url'] ) ) : '';
		$out['title']         = isset( $input['title'] ) ? sanitize_text_field( $input['title'] ) : '';
		$out['subtitle']      = isset( $input['subtitle'] ) ? sanitize_text_field( $input['subtitle'] ) : '';
		$out['theme']         = ( isset( $input['theme'] ) && in_array( $input['theme'], array( 'light', 'dark', 'auto' ), true ) ) ? $input['theme'] : 'light';
		$out['track_events']  = empty( $input['track_events'] ) ? 0 : 1;
		return $out;
	}

	public static function render_settings_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$s   = self::settings();
		$opt = self::OPTION;
		$server = self::server_url();
		?>
		<div class="wrap">
			<h1>Rezerwacje Pilanka</h1>
			<p>Wstaw formularz na dowolną stronę shortcodem <code>[<?php echo esc_html( self::SHORTCODE ); ?>]</code>
				(w edytorze blokowym: blok „Shortcode”).</p>
			<?php if ( $server ) : ?>
				<p>Stan serwera: <a href="<?php echo esc_url( $server . '/health' ); ?>" target="_blank" rel="noopener"><?php echo esc_html( $server ); ?>/health</a>
					(powinno pokazać <code>{"status":"ok","db":"ok"}</code>).</p>
			<?php endif; ?>
			<form method="post" action="options.php">
				<?php settings_fields( 'pilanka_booking' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="pb-server">Adres serwera rezerwacji</label></th>
						<td><input type="url" class="regular-text code" id="pb-server" name="<?php echo esc_attr( $opt ); ?>[server_url]"
							value="<?php echo esc_attr( $s['server_url'] ); ?>" placeholder="https://rezerwacje.pilankapilatestczew.pl" required>
							<p class="description">Domena tej strony musi być wpisana na serwerze w <code>ALLOWED_ORIGINS</code>.</p></td>
					</tr>
					<tr>
						<th scope="row"><label for="pb-phone">Telefon studia</label></th>
						<td><input type="text" class="regular-text" id="pb-phone" name="<?php echo esc_attr( $opt ); ?>[contact_phone]"
							value="<?php echo esc_attr( $s['contact_phone'] ); ?>" placeholder="+48 600 000 000">
							<p class="description">Pokazywany pod formularzem („Wolisz zarezerwować telefonicznie?”) i przy błędach.</p></td>
					</tr>
					<tr>
						<th scope="row"><label for="pb-privacy">Polityka prywatności</label></th>
						<td><input type="url" class="regular-text" id="pb-privacy" name="<?php echo esc_attr( $opt ); ?>[privacy_url]"
							value="<?php echo esc_attr( $s['privacy_url'] ); ?>" placeholder="<?php echo esc_attr( get_privacy_policy_url() ); ?>">
							<p class="description">Puste = strona polityki prywatności ustawiona w WordPressie.</p></td>
					</tr>
					<tr>
						<th scope="row"><label for="pb-title">Nagłówek</label></th>
						<td><input type="text" class="regular-text" id="pb-title" name="<?php echo esc_attr( $opt ); ?>[title]"
							value="<?php echo esc_attr( $s['title'] ); ?>" placeholder="Zarezerwuj trening"></td>
					</tr>
					<tr>
						<th scope="row"><label for="pb-subtitle">Podtytuł</label></th>
						<td><input type="text" class="large-text" id="pb-subtitle" name="<?php echo esc_attr( $opt ); ?>[subtitle]"
							value="<?php echo esc_attr( $s['subtitle'] ); ?>" placeholder="Trzy kroki, bez zakładania konta. Termin potwierdzasz kodem SMS."></td>
					</tr>
					<tr>
						<th scope="row"><label for="pb-theme">Motyw</label></th>
						<td><select id="pb-theme" name="<?php echo esc_attr( $opt ); ?>[theme]">
							<option value="light" <?php selected( $s['theme'], 'light' ); ?>>Jasny</option>
							<option value="dark" <?php selected( $s['theme'], 'dark' ); ?>>Ciemny</option>
							<option value="auto" <?php selected( $s['theme'], 'auto' ); ?>>Automatyczny (wg systemu)</option>
						</select></td>
					</tr>
					<tr>
						<th scope="row">Analityka</th>
						<td><label><input type="checkbox" name="<?php echo esc_attr( $opt ); ?>[track_events]" value="1" <?php checked( $s['track_events'], 1 ); ?>>
							Wysyłaj konwersję po potwierdzonej rezerwacji (GA4 <code>booking_confirmed</code>, Meta Pixel <code>Schedule</code>, GTM <code>pilanka_booking_confirmed</code>)</label></td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}
}

Pilanka_Booking::init();
