#!/usr/bin/env python3

import sys
import struct



# Read a pascal string from d
def getPString(data, offset):
	l = data[offset]
	s = data[offset+1:offset+1+l]
	return s.decode('utf-8')

if len(sys.argv) < 3:
	raise SystemExit("usage: %s in.tvw out.tvw" % sys.argv[0])

with open(sys.argv[1], "rb") as f:
	indata = f.read(-1)
	# get a mutable bytes array so we can pop() from it
	data = bytearray(indata)
	i = 0

	# skip first part of the header
	# pstring
	i = i + data[i] + 1
	# uint32
	i = i + 4
	# version? pstring
	print("Forcing version to G34vS4z.")
	l = data[i]
	version = 'G34vS4z'
	data[i+1:i+1+l] = bytearray(version.encode('utf-8'))
	data[i] = len(version)
	i = i + data[i] + 1
	# unknown null byte, could be an empty string?
	print("Password:	%s" % getPString(data, i))
	print("Removing password.")
	l = data[i]
	del data[i+1:i+1+l]
	data[i] = 0


	with open(sys.argv[2], "wb") as fo:
		fo.write(data)
