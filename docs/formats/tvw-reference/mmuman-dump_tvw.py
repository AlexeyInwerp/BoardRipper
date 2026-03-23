#!/usr/bin/env python3

import sys
import struct



# Read a pascal string from d
def getPString(data):
	l = data.pop(0)
	s = data[0:l]
	del data[0:l]
	return s.decode('utf-8')

# Read an uint8 from d
def getUInt8(data):
	(i,) = struct.unpack("<B",data[0:1])
	del data[0:1]
	return i

# Read an int8 from d
def getInt8(data):
	(i,) = struct.unpack("<b",data[0:1])
	del data[0:1]
	return i

# Read an LE uint16 from d
def getUInt16(data):
	(i,) = struct.unpack("<H",data[0:2])
	del data[0:2]
	return i

# Read an LE int16 from d
def getInt16(data):
	(i,) = struct.unpack("<h",data[0:2])
	del data[0:2]
	return i

# Read an LE uint32 from d
def getUInt32(data):
	(i,) = struct.unpack("<I",data[0:4])
	del data[0:4]
	return i

# Read an LE int32 from d
def getInt32(data):
	(i,) = struct.unpack("<i",data[0:4])
	del data[0:4]
	return i

def dumpLayer(data, i):
	print("== Layer %d:" % i)
	print("LayerName	%s" % getPString(data))
	print("InitialName	%s" % getPString(data))
	print("Path	%s" % getPString(data))
	# Layer number??? no, not unique.
	# Some bitmask flags?
	layerTypes = ['Document', 'Top', 'Bottom', 'Signal', 'Power ground', 'Solder Mask [Top]', 'Solder Mask [Bottom]', 'Silkscreen [Top]', 'Silkscreen [Bottom]', 'Paste [Top]', 'Paste [Bottom]', 'Drill', 'Roul']
	print("Type	%s" % layerTypes[getUInt32(data)])
	print("PadColor	0x%x" % getUInt32(data))
	print("LineColor	0x%x" % getUInt32(data))
	# Whatever ?
	shapes = {}
	# maybe rather the start id for shapes
	nItems = getUInt32(data)
	print("nItems!?	%d" % nItems)

	# Read D-Code definitions
	dCodes = {}
	dCodeIdx = 10
	while True:
		unknownD = getUInt32(data)
		assert unknownD == 1
		w = getInt32(data)
		h = getInt32(data)
		if w == 0:
			# w = 0 & h = 1 ??
			break
		bounds = [w, h]
		shapeTypes = ['Round', 'Rectangle?', 'Round rectangle?', 'Oblong', 'circle??', 'FAIL to open', '??', '??', '???', '???']
		shape = getUInt32(data)
		# ???, curvature radius?
		extra1, extra2 = getInt32(data), getInt32(data)
		print("DCode %d: %i x %i (0x%x x 0x%x) %s (%i) E1: %d %x E2: %d %x" % (dCodeIdx, bounds[0], bounds[1], bounds[0], bounds[1], shapeTypes[shape], shape, extra1, extra1, extra2, extra2))
		dCodes[dCodeIdx] = (unknownD, bounds, shape, extra1, extra2)
		dCodeIdx += 1
	print("DCodes: %s" % dCodes)

	# Now it seems each shapes are listed sorted by types, with the count for each prefixed?

	nPad = getUInt32(data)
	print("\n== %d pads" % nPad)
	if nPad:
		print("?	0x%x" % getUInt32(data))
		for n in range(0, nPad):
			# Net, dCode, x, y, 
			# then 3 bytes? (flags?) Seems to indicate further data like hole definition
			p = {
		'net': getInt32(data),
		'dcode': getUInt32(data), 
		'x': getInt32(data),
		'y': getInt32(data),
		'u1': getUInt8(data),
		'u2': getUInt8(data),
		'u3': getUInt8(data)
		}
			print(p['dcode'])
			print("Pad(%s): %s" % (shapeTypes[dCodes[p['dcode']][2]], p))

	nLine = getUInt32(data)
	print("\n== %d lines" % nLine)
	if nLine:
		print("?	0x%x" % getUInt32(data))
		for n in range(0, nLine):
			# Net, dCode, x0, y0, x1, y1
			p = {
		'net': getInt32(data),
		'dcode': getUInt32(data),
		'x0': getInt32(data),
		'y0': getInt32(data),
		'x1': getInt32(data),
		'y1': getInt32(data),
		}
			print("Line(%s): %s" % (shapeTypes[dCodes[p['dcode']][2]], p))

	nArc = getUInt32(data)
	print("\n== %d arcs" % nArc)
	if nArc:
		print("?	0x%x" % getUInt32(data))
		for n in range(0, nArc):
			# Net, dCode, x, y, 3 * unknown
			a = {
		'net': getInt32(data),
		'dcode': getUInt32(data),
		'x': getInt32(data),
		'y': getInt32(data),
		'u1': getInt32(data),
		'u2': getInt32(data),
		'u3': getInt32(data),
		}
			print("Arc(%s): %s" % (shapeTypes[dCodes[a['dcode']][2]], a))

	nSurface = getUInt32(data)
	print("\n== %d surfaces" % nSurface)
	if nSurface:
		# should we pop it HERE?
		print("?	0x%x" % getUInt32(data))
		for n in range(0, nSurface):
			# or HERE??
			#print("?	0x%x" % getUInt32(data))
			print("\nSurface[%i]:" % n)
			net = getInt32(data)
			print("Net: %d" % (net))
			edgeCount = getUInt32(data)
			print("=== %d edges %x" % (edgeCount, edgeCount))
			#startX, startY = getInt32(data), getInt32(data)
			edges = []
			for e in range(0, edgeCount):
				edges.append([getInt32(data), getInt32(data)])
			print(edges)
			# linewidth??
			unknownS = getInt32(data)
			print("???	%d %x" % (unknownS, unknownS))
			assert unknownS == 0
			voidCount = getUInt32(data)
			print("=== %d voids" % voidCount)
			if voidCount:
				voids = {}
				for v in range(0, voidCount):
					print("?	0x%x" % getUInt32(data))
					voids[v] = []
					voidEdgeCount = getUInt32(data)
					print("void(%i):	%i edges" % (v, voidEdgeCount))
					for e in range(0, voidEdgeCount):
						edge = getInt32(data), getInt32(data)
						print(edge)
						voids[v].append(edge)
					print(voids[v])
#			else:
#				print("?	0x%x" % getUInt32(data))

	# unknown
	assert getUInt32(data) == 0

	nText = getUInt32(data)
	print("\n== %d texts" % nText)
	if nText:
		print("?	0x%x" % getUInt32(data))
		for n in range(0, nText):
			text = getPString(data)
			print("Text:	%s" % (text))
			print("?	0x%x" % (getUInt32(data)))
			print("?	0x%x" % (getUInt32(data)))
			print("?	0x%x" % (getUInt32(data)))
			print("?	0x%x" % (getUInt32(data)))
			print("?	0x%x" % (getUInt32(data)))
			print("?	0x%x" % (getUInt32(data)))
			print("?	0x%x" % (getUInt32(data)))



	print("?	0x%x" % (getUInt32(data)))
	print("?	0x%x" % (getUInt32(data)))
	print("?	0x%x" % (getUInt32(data)))

	print("?	0x%x" % (getUInt32(data)))
	print("?	0x%x" % (getUInt32(data)))
	print("?	0x%x" % (getUInt32(data)))

	print("?	0x%x" % (getUInt32(data)))
	print("?	0x%x" % (getUInt32(data)))
	print("?	0x%x" % (getUInt32(data)))

	print("?	0x%x" % (getUInt32(data)))
	print("?	0x%x" % (getUInt32(data)))
	print("?	0x%x" % (getUInt32(data)))

	print("?	0x%x" % (getUInt32(data)))
	print("?	0x%x" % (getUInt32(data)))
	print("?	0x%x" % (getUInt32(data)))



def unused():
	for n in range(0, nItems):
		#nShapes = getUInt32(data)
		#for m in range(0, nShapes):
		# is it some item type or count ?
		itemType = getUInt32(data)
		if itemType == 1:
			# bounds ?
			bounds = getInt32(data), getInt32(data)
			print(bounds)
			if bounds != (0, 1):
				shapeType = getUInt32(data)
				shapeTypes = ['rounded??', 'rect', 'empty??', 'Round', 'circle', 'FAIL to open', '??', '??', '???', '???']
				print("shapeType: 0x%x" % shapeType)
				print("Shape: %s (0x%x) %i x %i (0x%x x 0x%x)" % (shapeTypes[shapeType], shapeType, bounds[0], bounds[1], bounds[0], bounds[1]))
				unknown = getInt32(data)
				print("?	0x%x" % (unknown))
				# curvature radius?
				radius = getInt32(data)
				print("radius?	0x%x %i" % (radius, radius))
				shapes.append({'type': shapeType, 'bounds': bounds, 'args': [unknown, radius]})
			else:
				nPads = getInt32(data)
				print("nPads?	0x%x" % (nPads))
				unknown1 = getInt32(data)
				print("?	0x%x" % (unknown1))
				unknown2 = getInt32(data)
				print("?	0x%x" % (unknown2))
				for m in range(0, nPads):
					idx = getInt32(data)
					print("shapeIndex	0x%x %i" % (idx, idx))
					pos = getInt32(data), getInt32(data)
					print("shape[%i] at %i x %i (0x%x x 0x%x)" % (idx, pos[0], pos[1], pos[0], pos[1]))
					unknownP = getInt32(data)
					print("?	0x%x" % (unknownP))
					# 3 unknown null bytes, could be empty strings?
					print("?	%s" % getPString(data))
					print("?	%s" % getPString(data))
					print("?	%s" % getPString(data))
		elif itemType == 8:
			unknown = getInt32(data)
			print("?	0x%x %i" % (unknown, unknown))
			print("?	0x%x %i" % (unknown, unknown))
			
			
		else:
			raise SystemExit("Unknown itemType %s" % itemType)

if len(sys.argv) < 2:
	raise SystemExit("usage: %s file.tvw" % sys.argv[0])

with open(sys.argv[1], "rb") as f:
	data = f.read(-1)
	# get a mutable bytes array so we can pop() from it
	data = bytearray(data)

	print("== Header:")
	print("?	%s" % getPString(data))
	print("?	0x%x" % getUInt32(data))
	print("?	%s" % getPString(data))
	# unknown null byte, could be an empty string?
	print("?	%s" % getPString(data))
	#print("?	%x" % data.pop(0))
	# some per layer flags in ASCII maybe? Length doesn't match layer count though
	print("?	%s" % getPString(data))
	# 3 unknown null bytes, could be empty strings?
	print("?	%s" % getPString(data))
	print("?	%s" % getPString(data))
	print("?	%s" % getPString(data))

	print("?	0x%x" % getUInt32(data))
	print("?	0x%x" % getUInt32(data))
	print("?	0x%x" % getUInt32(data))
	nrLayers = getUInt32(data)
	print("nrLayers	%i" % nrLayers)

	# could this actually be part of the first layer?
	print("?	0x%x" % getUInt32(data))
	print("?	0x%x" % getUInt32(data))
	print("?	0x%x" % getUInt32(data))
	print("?	0x%x" % getUInt32(data))
	print()

	for i in range(0, nrLayers):
		dumpLayer(data, i)




# hints: strings from:

# DCodeManagerModule.dll
#donut%sx%s
#rect%sx%sxr%s
#rect%sx%sxr%sxa%d
#oval%sx%s
#oval%sx%sxa%d
#rect%sx%s
#rect%sx%sxa%d
#
#triangle
#diamond
#hexagon
#Octagon
#Thermal
#Target

# IctGraphicFunction.dll
#?AddPad_Circle@CPhysicLayerEditor@@QAEPAVIPad@@PAUtagPOINT@@J@Z
#?AddPad_Rect@CPhysicLayerEditor@@QAEPAVIPad@@PAUtagPOINT@@JJN@Z
#?AddPad_Oblong@CPhysicLayerEditor@@QAEPAVIPad@@PAUtagPOINT@@JJN@Z
#?AddPad_Donut@CPhysicLayerEditor@@QAEPAVIPad@@PAUtagPOINT@@JJ@Z
#?AddPad_Thermal@CPhysicLayerEditor@@QAEPAVIPad@@PAUtagPOINT@@JJJN@Z
#?AddPad_DCode@CPhysicLayerEditor@@QAEPAVIPad@@PAUtagPOINT@@PAVIDCodeManager@@H@Z

# OutputPcbFunction.dll
#Pads
#TestPoints
#Fonts
#LayerSets
#LayerNames
#Layers
#Padstacks
#Parts
#Packages
#Padsymbols
#Nets
#Fab

# IctData.dll
#TestPad
#DrlLayer
#MillLayer
#PanelLayer
#Line
#Surface
#Text
#ColorLine
#DrlHole
#DrlCircle
#DrlSlot
#DrlArc
#MillPoly
#MillZBrushRemark
#Panel
#TestPad HoleSize
#TestPad Mask
#TestPad DCode
#%s(%d)
#TestPad Net
#TestPad CenterPoint Y Coordinate
#TestPad CenterPoint X Coordinate
#TestPad Name
#TestPad Is TP
#Unknown(%d)
#TestPad Type
#TestPad No
#Layer Type
#Layer Pad Color
#Layer Line Color
#Layer Name
#Layer Init Name
#Layer Line/Pad Visible
#Layer Init Path
#Drl From Layer
#Drl To Layer
#.aft
#complex
#italic
#romans
#\Setting\
#Auto-ICT Font 1.0
#Pad CenterPoint X Coordinate
#Pad CenterPoint Y Coordinate
#UnTest Reason
#Pad Hole CenterPoint Coordinate
#Pad Hole Size cy
#Pad Hole Size cx
#Pad Mask
#DCode Height
#DCode Width
#DCode Shape
#DCode No.
#Net No.
#EndPoint Y Coordinate
#EndPoint X Coordinate
#BeginPoint Y Coordinate
#BeginPoint X Coordinate
#StartPoint Y Coordinate
#StartPoint X Coordinate
#CenterPoint Y Coordinate
#CenterPoint X Coordinate
#StartAngle
#%.2f
#SweepAngle
#Clockwise
#Surface edge num
#Line Width
#%d(I%d)
#Surface void num
#False
#True
#Text mirror
#Text angle
#Text Location
#Text Content
#Font Weight
#Font Height
#Text Font
#Text Color
#Line Color
#Hole CenterPoint X Coordinate
#Hole CenterPoint Y Coordinate
#Tool No.
#Tool Size
#Circle CenterPoint X Coordinate
#Circle CenterPoint Y Coordinate
#Circle Diameter
#Z Value
#Accurate Tool Size
#Accurate Tool No.
#Inch
#[%d]%s
#Angle
#NC_%d
#IctData.dll
#Arial
#BOTTOM
#%%2.%df
