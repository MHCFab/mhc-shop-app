# Rebuilds the three onboarding spreadsheets in public/onboarding/.
# Run from public/onboarding:  python ../../scripts/build-onboarding-sheets.py  (needs: pip install openpyxl)
# Keep the column headers in step with the import SQL - that is what this file is for.
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

F = "Arial"
HDR_FILL = PatternFill("solid", fgColor="181E24")
REQ_FILL = PatternFill("solid", fgColor="A8441A")
EX_FILL = PatternFill("solid", fgColor="EEF1F4")
thin = Side(style="thin", color="C9CED4")
BORDER = Border(top=thin, bottom=thin, left=thin, right=thin)
ROWS = 500  # rows with dropdowns/validation

SHAPES = ["Round Tube","Square Tube","Rectangle Tube","Channel","I-Beam","Angle","Flat Bar"]
CATS = ["Laser Part","Fastener","Caster","Machined Part","Electrical","Hardware","Other"]
TYPES = ["Product","Sub-assembly","Fabricated part"]
YESNO = ["Yes","No"]

def start_tab(wb, title, intro, steps, tabs):
    ws = wb.active
    ws.title = "Start here"
    ws.sheet_view.showGridLines = False
    ws.column_dimensions["A"].width = 3
    ws.column_dimensions["B"].width = 26
    ws.column_dimensions["C"].width = 90
    ws["B2"] = "ShopWorks onboarding"
    ws["B2"].font = Font(name=F, size=10, color="A8441A", bold=True)
    ws["B3"] = title
    ws["B3"].font = Font(name=F, size=18, bold=True, color="181E24")
    r = 5
    for line in intro:
        ws.cell(r, 2, line).font = Font(name=F, size=11)
        ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=3)
        ws.cell(r, 2).alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[r].height = 30
        r += 1
    r += 1
    ws.cell(r, 2, "How to fill it in").font = Font(name=F, size=12, bold=True)
    r += 1
    for i, s in enumerate(steps, 1):
        ws.cell(r, 2, f"{i}.").font = Font(name=F, size=11, bold=True)
        c = ws.cell(r, 3, s); c.font = Font(name=F, size=11); c.alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[r].height = 30 if len(s) > 90 else 16
        r += 1
    r += 1
    ws.cell(r, 2, "The tabs in this file").font = Font(name=F, size=12, bold=True)
    r += 1
    for name, desc in tabs:
        ws.cell(r, 2, name).font = Font(name=F, size=11, bold=True)
        c = ws.cell(r, 3, desc); c.font = Font(name=F, size=11); c.alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[r].height = 30 if len(desc) > 90 else 16
        r += 1
    r += 1
    ws.cell(r, 2, "Legend").font = Font(name=F, size=12, bold=True); r += 1
    c = ws.cell(r, 2, "Rust header"); c.fill = REQ_FILL; c.font = Font(name=F, size=10, bold=True, color="FFFFFF")
    ws.cell(r, 3, "Required column - every row needs it.").font = Font(name=F, size=11); r += 1
    c = ws.cell(r, 2, "Dark header"); c.fill = HDR_FILL; c.font = Font(name=F, size=10, bold=True, color="FFFFFF")
    ws.cell(r, 3, "Optional column - leave blank if it doesn't apply.").font = Font(name=F, size=11); r += 1
    c = ws.cell(r, 2, "Grey row"); c.fill = EX_FILL; c.font = Font(name=F, size=10, italic=True, color="555555")
    ws.cell(r, 3, "Example showing the format. Type over it or delete it - we ignore any row still marked EXAMPLE.").font = Font(name=F, size=11); r += 2
    ws.cell(r, 2, "When you're done").font = Font(name=F, size=12, bold=True); r += 1
    c = ws.cell(r, 2, "Email all three files to support@mhcfab.com with your shop name in the subject. We load them, then let you know your shop is ready to check.")
    c.font = Font(name=F, size=11); ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=3)
    c.alignment = Alignment(wrap_text=True); ws.row_dimensions[r].height = 30

def data_tab(wb, name, cols, examples, note=None):
    """cols: list of (header, width, required, kind, options) kind in text|num|int|list"""
    ws = wb.create_sheet(name)
    ws.freeze_panes = "A2"
    for i, (h, w, req, kind, opts, tip) in enumerate(cols, 1):
        c = ws.cell(1, i, h + (" *" if req else ""))
        c.font = Font(name=F, size=10, bold=True, color="FFFFFF")
        c.fill = REQ_FILL if req else HDR_FILL
        c.alignment = Alignment(wrap_text=True, vertical="center")
        c.border = BORDER
        ws.column_dimensions[get_column_letter(i)].width = w
        col = get_column_letter(i)
        rng = f"{col}2:{col}{ROWS+1}"
        dv = None
        if kind == "list":
            dv = DataValidation(type="list", formula1='"' + ",".join(opts) + '"', allow_blank=True)
            dv.error = "Pick one from the list."; dv.errorTitle = h
        elif kind == "num":
            dv = DataValidation(type="decimal", operator="greaterThanOrEqual", formula1="0", allow_blank=True)
            dv.error = "Enter a number (no $ or units)."; dv.errorTitle = h
        elif kind == "int":
            dv = DataValidation(type="whole", operator="greaterThanOrEqual", formula1="0", allow_blank=True)
            dv.error = "Enter a whole number."; dv.errorTitle = h
        if dv is not None:
            dv.showErrorMessage = True
            if tip:
                dv.prompt = tip; dv.promptTitle = h; dv.showInputMessage = True
            ws.add_data_validation(dv); dv.add(rng)
        elif tip:
            dv = DataValidation(type="custom", formula1="TRUE", allow_blank=True)
            dv.prompt = tip; dv.promptTitle = h; dv.showInputMessage = True
            ws.add_data_validation(dv); dv.add(rng)
        if kind in ("num",):
            for r in range(2, ROWS + 2):
                ws.cell(r, i).number_format = "0.00##"
    ws.row_dimensions[1].height = 32
    for r_i, ex in enumerate(examples, 2):
        for i, v in enumerate(ex, 1):
            c = ws.cell(r_i, i, v)
            c.fill = EX_FILL; c.font = Font(name=F, size=10, italic=True, color="555555"); c.border = BORDER
    for r in range(2 + len(examples), ROWS + 2):
        for i in range(1, len(cols) + 1):
            ws.cell(r, i).font = Font(name=F, size=10)
    return ws

# ---------------------------------------------------------------- 1
wb = Workbook()
start_tab(wb, "1 of 3 - Raw material and purchased parts",
 ["This is everything you keep on the rack and on the shelf: the steel you cut from, and the parts you buy in. Products and bills of material (files 2 and 3) refer back to what's listed here, so fill this one in first.",
  "Don't worry about perfection. A close count today beats an exact count next month - you can adjust stock in ShopWorks any time."],
 ["On the Raw material tab, add one row per material and stick length. If you stock 2 x 2 x 11 ga square tube in both 20' and 24' sticks, that's two rows.",
  "Write sizes the way your shop says them (2 x 2, 1-1/2 OD, 3 x 1/4). Put the wall or thickness in its own column for tube, channel and angle.",
  "Cost per foot is what you paid, in dollars - numbers only, no $ sign.",
  "On the Purchased parts tab, add one row per part you buy in: laser parts, fasteners, casters, hardware. Quantity on hand can be 0.",
  "Name each part the way you'd want to find it later. If two parts could be confused, give them a part number."],
 [("Raw material", "Bar, tube, angle, channel, beam - by shape, size, wall and grade, with cost per foot and what's on the rack now."),
  ("Purchased parts", "Anything you buy finished and bolt or weld on: laser-cut parts, fasteners, casters, hardware.")])
data_tab(wb, "Raw material", [
 ("Shape", 16, True, "list", SHAPES, "Pick from the list."),
 ("Size", 16, True, "text", None, "As your shop says it: 2 x 2, 1-1/2 OD, 3 x 1/4."),
 ("Wall / thickness", 16, False, "text", None, "For tube, channel and angle: 11 ga, 0.120, 3/16."),
 ("Grade", 12, True, "text", None, "A500, A36, 304 SS..."),
 ("Cost per foot ($)", 14, True, "num", None, "Dollars per foot, numbers only."),
 ("Stick length on hand (ft)", 14, False, "num", None, "Length of the sticks on your rack, in feet."),
 ("Sticks on hand", 12, False, "int", None, "How many full sticks of that length."),
 ("Notes", 36, False, "text", None, None)],
 [["Square Tube","2 x 2","11 ga","A500",3.10,24,12,"EXAMPLE"],
  ["Flat Bar","2 x 1/4","","A36",1.45,20,8,"EXAMPLE"]])
data_tab(wb, "Purchased parts", [
 ("Part name", 32, True, "text", None, "How you'd search for it: 3/8-16 x 1 hex bolt, 4in swivel caster."),
 ("Part number", 16, False, "text", None, "Your number or the supplier's."),
 ("Category", 16, True, "list", CATS, "Pick from the list."),
 ("Description", 32, False, "text", None, None),
 ("Cost each ($)", 12, True, "num", None, "Dollars, numbers only."),
 ("Quantity on hand", 12, False, "int", None, "Can be 0."),
 ("Notes", 32, False, "text", None, None)],
 [["4in swivel caster w/ brake","CST-4SB","Caster","Polyurethane wheel, 300 lb",14.75,16,"EXAMPLE"],
  ["Gate hinge plate","LP-1042","Laser Part","3/16 plate, 2 holes",6.20,40,"EXAMPLE"]])
wb.save("ShopWorks-Onboarding-1-Material-and-Parts.xlsx")

# ---------------------------------------------------------------- 2
wb = Workbook()
start_tab(wb, "2 of 3 - Products",
 ["These are the things you build over and over. Each one becomes a product template in ShopWorks, so a new job for it fills in its material, parts and tasks by itself.",
  "Start with the products you build most. You can add the rest yourself later in ShopWorks."],
 ["On the Products tab, add one row per product. Give each a product number if you use them - it's how files 2 and 3 refer to it. If you don't use numbers, the name has to be unique.",
  "Type: Product is something you sell. Sub-assembly is a complete piece you sell on its own AND use inside bigger products. Fabricated part is one piece of a bigger assembly that you never sell on its own.",
  "Customer is optional. Fill it in if a product is only ever built for one customer - it files the template under them.",
  "On the Tasks tab, list the steps to build one unit of each product, in order, with a rough time per unit in minutes. These become the tasks your crew clocks onto."],
 [("Products", "One row per product, sub-assembly or fabricated part."),
  ("Tasks", "The steps to build one unit, in order, with estimated minutes per unit.")])
data_tab(wb, "Products", [
 ("Product number", 16, False, "text", None, "Your number for it. Used by files 2 and 3 to point at this product."),
 ("Product name", 34, True, "text", None, None),
 ("Type", 16, True, "list", TYPES, "Product, Sub-assembly or Fabricated part."),
 ("Customer", 24, False, "text", None, "Only if it's built for one customer."),
 ("Description", 36, False, "text", None, None),
 ("Keep some built ahead? (Yes/No)", 16, False, "list", YESNO, "Sub-assemblies and fabricated parts only: do you build these to stock?"),
 ("Notes", 30, False, "text", None, None)],
 [["DG-6","6 ft dumpster enclosure gate","Product","","Single leaf, 2x2 frame, 1x1 pickets","","EXAMPLE"],
  ["HP-1","Gate hinge post assembly","Fabricated part","","","Yes","EXAMPLE"]])
data_tab(wb, "Tasks", [
 ("Product number or name", 24, True, "text", None, "Must match a row on the Products tab."),
 ("Step #", 8, True, "int", None, "1, 2, 3... the order on the floor."),
 ("Task name", 26, True, "text", None, "Cut, Fit, Weld, Grind, Paint..."),
 ("Minutes per unit", 12, True, "num", None, "Rough time for ONE unit, in minutes."),
 ("Description", 40, False, "text", None, "Anything the crew should know for this step.")],
 [["DG-6",1,"Cut",25,"EXAMPLE - frame and pickets"],
  ["DG-6",2,"Fit and weld",90,"EXAMPLE"],
  ["DG-6",3,"Grind and prep",30,"EXAMPLE"]])
wb.save("ShopWorks-Onboarding-2-Products.xlsx")

# ---------------------------------------------------------------- 3
wb = Workbook()
start_tab(wb, "3 of 3 - Bills of material",
 ["This is what goes into ONE unit of each product from file 2: the material, the bought-in parts, and any of your own sub-assemblies. The cut list tab is optional, but fill it in if you want ShopWorks to build cutting nests for you.",
  "Every product here must be on the Products tab of file 2, and every material and part must be in file 1."],
 ["In the Product column on every tab, use the product number from file 2 (or the exact name if you don't use numbers).",
  "Material: feet of each material for one unit, including a little for waste if you normally allow it. Shape, size, wall and grade must match a row in file 1.",
  "Parts: how many of each bought-in part go into one unit. Use the part name or part number from file 1.",
  "Sub-assemblies: when one of your products is built into another (a hinge post into a gate), list it here with the quantity per unit.",
  "Cut list (optional): each piece cut for one unit - its length in inches on the long point, how many, and the end angles in degrees (0 = square). Mark Handed = Yes if a left and right are not interchangeable."],
 [("Material", "Feet of each raw material per unit."),
  ("Parts", "Quantity of each purchased part per unit."),
  ("Sub-assemblies", "Your own products used inside other products."),
  ("Cut list", "Optional. Individual cut pieces per unit, for cutting nests.")])
MATCOLS = [("Shape", 15, True, "list", SHAPES, "Must match file 1."),
 ("Size", 14, True, "text", None, "Must match file 1."),
 ("Wall / thickness", 14, False, "text", None, "Must match file 1."),
 ("Grade", 11, False, "text", None, "Only needed if you stock the same size in two grades.")]
data_tab(wb, "Material",
 [("Product number or name", 24, True, "text", None, "From file 2.")] + MATCOLS +
 [("Feet per unit", 12, True, "num", None, "Feet of this material in ONE unit."),
  ("Notes", 30, False, "text", None, None)],
 [["DG-6","Square Tube","2 x 2","11 ga","A500",26,"EXAMPLE"],
  ["DG-6","Square Tube","1 x 1","16 ga","A500",48,"EXAMPLE"]])
data_tab(wb, "Parts", [
 ("Product number or name", 24, True, "text", None, "From file 2."),
 ("Part name or number", 32, True, "text", None, "From file 1."),
 ("Quantity per unit", 12, True, "num", None, "How many in ONE unit."),
 ("Notes", 30, False, "text", None, None)],
 [["DG-6","Gate hinge plate",4,"EXAMPLE"]])
data_tab(wb, "Sub-assemblies", [
 ("Product number or name", 24, True, "text", None, "The bigger product, from file 2."),
 ("Uses product (number or name)", 28, True, "text", None, "The sub-assembly or fabricated part going into it, from file 2."),
 ("Quantity per unit", 12, True, "num", None, "How many in ONE unit."),
 ("Notes", 30, False, "text", None, None)],
 [["DG-6","HP-1",1,"EXAMPLE"]])
data_tab(wb, "Cut list",
 [("Product number or name", 22, True, "text", None, "From file 2.")] + MATCOLS +
 [("Mark", 12, False, "text", None, "Your mark for the piece: POST, RAIL-A."),
  ("Length (in, long point)", 13, True, "num", None, "Inches, measured on the long point."),
  ("Pieces per unit", 10, True, "int", None, "How many of this piece in ONE unit."),
  ("Lead end angle (deg)", 11, False, "num", None, "0 = square cut."),
  ("Trail end angle (deg)", 11, False, "num", None, "0 = square cut."),
  ("Handed? (Yes/No)", 10, False, "list", YESNO, "Yes if a left and right are not interchangeable."),
  ("Notes", 26, False, "text", None, None)],
 [["DG-6","Square Tube","2 x 2","11 ga","A500","STILE",70.5,2,0,0,"No","EXAMPLE"],
  ["DG-6","Square Tube","2 x 2","11 ga","A500","BRACE",88.25,1,45,45,"No","EXAMPLE"]])
wb.save("ShopWorks-Onboarding-3-Bills-of-Material.xlsx")
print("ok")
