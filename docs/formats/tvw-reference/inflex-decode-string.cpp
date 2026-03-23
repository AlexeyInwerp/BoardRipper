#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

char dec['z'+1][11] = {0};
char enc['z'+1][11] = {0};

#define RWIDTH 10

void translate_init( void ) {

	memset(dec, 0, sizeof(dec));
	memset(enc, 0, sizeof(enc));

	snprintf(dec['0'], (RWIDTH +1), "efgefgefge");
	snprintf(dec['1'], (RWIDTH +1), "fghfghfghf");
	snprintf(dec['2'], (RWIDTH +1), "ghighighig");
	snprintf(dec['3'], (RWIDTH +1), "hijhijhijh");
	snprintf(dec['4'], (RWIDTH +1), "ijaijaijai");
	snprintf(dec['5'], (RWIDTH +1), "jabjabjabj");
	snprintf(dec['6'], (RWIDTH +1), "abcabcabca");
	snprintf(dec['7'], (RWIDTH +1), "bcdbcdbcdb");
	snprintf(dec['8'], (RWIDTH +1), "cdecdecdec");
	snprintf(dec['9'], (RWIDTH +1), "defdefdefd");

	snprintf(dec['a'], (RWIDTH +1), "3453453453");
	snprintf(dec['b'], (RWIDTH +1), "2342342342");
	snprintf(dec['c'], (RWIDTH +1), "1231231231");
	snprintf(dec['d'], (RWIDTH +1), "0120120120");
	snprintf(dec['e'], (RWIDTH +1), "9019019019");
	snprintf(dec['f'], (RWIDTH +1), "8908908908");
	snprintf(dec['g'], (RWIDTH +1), "7897897897");
	snprintf(dec['h'], (RWIDTH +1), "6786786786");
	snprintf(dec['i'], (RWIDTH +1), "5675675675");
	snprintf(dec['j'], (RWIDTH +1), "4564564564");
	snprintf(dec['k'], (RWIDTH +1), "vutsrqponm");
	snprintf(dec['l'], (RWIDTH +1), "wvutsrqpon");
	snprintf(dec['m'], (RWIDTH +1), "xwvutsrqpo");
	snprintf(dec['n'], (RWIDTH +1), "yxwvutsrqp");
	snprintf(dec['o'], (RWIDTH +1), "zyxwvutsrq");
	snprintf(dec['p'], (RWIDTH +1), "kzyxwvutsr");
	snprintf(dec['q'], (RWIDTH +1), "lkzyxwvuts");
	snprintf(dec['r'], (RWIDTH +1), "mlkzyxwvut");
	snprintf(dec['s'], (RWIDTH +1), "nmlkzyxwvu");
	snprintf(dec['t'], (RWIDTH +1), "onmlkzyxwv");
	snprintf(dec['u'], (RWIDTH +1), "ponmlkzyxw");
	snprintf(dec['v'], (RWIDTH +1), "qponmlkzyx");
	snprintf(dec['w'], (RWIDTH +1), "rqponmlkzy");
	snprintf(dec['x'], (RWIDTH +1), "srqponmlkz");
	snprintf(dec['y'], (RWIDTH +1), "tsrqponmlk");
	snprintf(dec['z'], (RWIDTH +1), "utsrqponml");

	snprintf(dec['A'], (RWIDTH +1), "FGHIJKLMNO");
	snprintf(dec['B'], (RWIDTH +1), "GHIJKLMNOP");
	snprintf(dec['C'], (RWIDTH +1), "HIJKLMNOPQ");
	snprintf(dec['D'], (RWIDTH +1), "IJKLMNOPQR");
	snprintf(dec['E'], (RWIDTH +1), "JKLMNOPQRS");
	snprintf(dec['F'], (RWIDTH +1), "KLMNOPQRST");
	snprintf(dec['G'], (RWIDTH +1), "LMNOPQRSTU");
	snprintf(dec['H'], (RWIDTH +1), "MNOPQRSTUV");
	snprintf(dec['I'], (RWIDTH +1), "NOPQRSTUVW");
	snprintf(dec['J'], (RWIDTH +1), "OPQRSTUVWX");
	snprintf(dec['K'], (RWIDTH +1), "PQRSTUVWXY");
	snprintf(dec['L'], (RWIDTH +1), "QRSTUVWXYZ");
	snprintf(dec['M'], (RWIDTH +1), "RSTUVWXYZA");
	snprintf(dec['N'], (RWIDTH +1), "STUVWXYZAB");
	snprintf(dec['O'], (RWIDTH +1), "TUVWXYZABC");
	snprintf(dec['P'], (RWIDTH +1), "UVWXYZABCD");
	snprintf(dec['Q'], (RWIDTH +1), "VWXYZABCDE");
	snprintf(dec['R'], (RWIDTH +1), "WXYZABCDEF");
	snprintf(dec['S'], (RWIDTH +1), "XYZABCDEFG");
	snprintf(dec['T'], (RWIDTH +1), "YZABCDEFGH");
	snprintf(dec['U'], (RWIDTH +1), "ZABCDEFGHI");
	snprintf(dec['V'], (RWIDTH +1), "ABCDEFGHIJ");
	snprintf(dec['W'], (RWIDTH +1), "BCDEFGHIJK");
	snprintf(dec['X'], (RWIDTH +1), "CDEFGHIJKL");
	snprintf(dec['Y'], (RWIDTH +1), "DEFGHIJKLM");
	snprintf(dec['Z'], (RWIDTH +1), "EFGHIJKLMN");


	// Generate the encoding matrix
	//
	for (unsigned int c = 0; c < RWIDTH; c++) {
		for (unsigned int z = 0; z < '0'; z++) {
			enc[z][c] = 0;
		}
	}

	for (unsigned int c = 0; c < RWIDTH; c++) {
		for (unsigned int z = '0'; z <= 'z'; z++) {
			unsigned int o;
			if (isalpha(z)) {
				o = dec[z][c];
				enc[o][c] = z;
			}
			else if (isdigit(z)) {
				o = dec[z][c % 3];
				enc[o][c] = z;
			}
		}
	}

}


int decode( char *dest, char *s, ssize_t l ) {
	ssize_t i = 0;

	while ( i < l && *s ) {
		if (isdigit(*s) || (*s >= 'a' && *s <= 'j')) {
			dest[i] = dec[(ssize_t)*s][i % 3];

		}
		else if (isalpha(*s)) {
			dest[i] = dec[(ssize_t)*s][i % RWIDTH];

		} else {
			dest[i] = *s;
		}
		i++;
		s++;
	}
	dest[l] = 0;
	return 0;
}

int encode( char *dest, char *s, ssize_t l ) {
	ssize_t i = 0;
	while ( i < l && *s ) {

		if (isdigit(*s) || (*s >= 'a' && *s <= 'j')) {
			dest[i] = enc[(ssize_t)*s][i % 3];

		} else if (isalpha(*s)) {
			dest[i] = enc[(ssize_t)*s][i % RWIDTH];

		} else {
			dest[i] = *s;
		}
		i++;
		s++;
	}
	dest[l] = 0;
	return 0;
}

int main( int argc, char **argv ) {

	translate_init();

	// Dump the decoding matrix
	//
	fprintf(stdout,"// Decoding Matrix\n");
	fprintf(stdout,"//\n");
	fprintf(stdout,"char dec['z'+1][%d] = {\n", RWIDTH+1);
	for (int i = 0; i <= 'z'; i++) {
		fprintf(stdout,"\t { ");
		for (int j = 0; j < RWIDTH; j++) {
			char o = dec[i][j];
			if (isprint(o)) {
				fprintf(stdout, "'%c'%s", o, j==(RWIDTH-1)?"":", ");
			} else {
				fprintf(stdout, "%d%s", o, j==(RWIDTH-1)?"":", ");
			}
		}
		if (isprint(i)) fprintf(stdout," }, // '%c'\n", i);
		else fprintf(stdout," }, // 0x%X\n", i);
	}
	fprintf(stdout,"}; // decoding matrix\n\n");


	fprintf(stdout,"// Encoding Matrix\n");
	fprintf(stdout,"//\n");
	fprintf(stdout,"char enc['z'+1][%d] = {\n", RWIDTH +1);
	for (int i = 0; i <= 'z'; i++) {
		fprintf(stdout,"\t{ ");
		for (int c = 0; c < RWIDTH; c++) {
			char o = enc[i][c];
			if (isprint(o)) {
				fprintf(stdout, "'%c'%s", o, c==(RWIDTH -1)?"":", ");
			} else {
				fprintf(stdout, "%d%s", o, c==(RWIDTH -1)?"":", ");
			}
		}
		if (isprint(i)) fprintf(stdout," }, // '%c'\n", i);
		else fprintf(stdout," }, // 0x%X\n", i);
	}
	fprintf(stdout,"}; //encoding matrix\n\n");

	if (argc == 2) {
		char dbuf[100];
		char ebuf[100];
		fprintf(stdout,"%s\n", argv[1]);
		decode(dbuf, argv[1], strlen(argv[1]));
		fprintf(stdout,"%s\n", dbuf);
		encode(ebuf, dbuf, strlen(dbuf));
		fprintf(stdout,"%s\n", ebuf);
	}
	return 0;
}
