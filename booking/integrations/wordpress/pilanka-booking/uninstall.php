<?php
// Usunięcie ustawień przy odinstalowaniu wtyczki.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}
delete_option( 'pilanka_booking_settings' );
