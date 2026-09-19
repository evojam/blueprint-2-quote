import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'

const outputDir = path.dirname(fileURLToPath(import.meta.url))
const BLACK = '#111827'
const MUTED = '#475569'
const BLUE = '#1d4ed8'
const RED = '#b91c1c'

function page(width, height, title) {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.fillStyle = BLACK
  context.font = 'bold 30px sans-serif'
  context.fillText(title, 54, 54)
  context.strokeStyle = '#cbd5e1'
  context.lineWidth = 2
  context.strokeRect(30, 24, width - 60, height - 48)
  return { canvas, context }
}

function label(context, text, x, y, options = {}) {
  context.save()
  context.fillStyle = options.color ?? BLACK
  context.font = `${options.weight ?? 'normal'} ${options.size ?? 22}px sans-serif`
  context.textAlign = options.align ?? 'left'
  context.textBaseline = options.baseline ?? 'alphabetic'
  context.fillText(text, x, y)
  context.restore()
}

function dimension(context, startX, startY, endX, endY, text, textX, textY, rotation = 0) {
  context.save()
  context.strokeStyle = BLUE
  context.fillStyle = BLUE
  context.lineWidth = 3
  context.beginPath()
  context.moveTo(startX, startY)
  context.lineTo(endX, endY)
  context.stroke()

  const angle = Math.atan2(endY - startY, endX - startX)
  for (const [x, y, direction] of [
    [startX, startY, angle],
    [endX, endY, angle + Math.PI],
  ]) {
    context.beginPath()
    context.moveTo(x, y)
    context.lineTo(x + 13 * Math.cos(direction - 0.45), y + 13 * Math.sin(direction - 0.45))
    context.lineTo(x + 13 * Math.cos(direction + 0.45), y + 13 * Math.sin(direction + 0.45))
    context.closePath()
    context.fill()
  }

  context.translate(textX, textY)
  context.rotate(rotation)
  context.fillStyle = BLUE
  context.font = 'bold 22px sans-serif'
  context.textAlign = 'center'
  context.fillText(text, 0, 0)
  context.restore()
}

function completeRectangle() {
  const { canvas, context } = page(1200, 800, 'FLOOR PLAN - COMPLETE RECTANGLE')
  const left = 220
  const top = 190
  const right = 980
  const bottom = 610

  context.fillStyle = '#f8fafc'
  context.fillRect(left, top, right - left, bottom - top)
  context.strokeStyle = BLACK
  context.lineWidth = 10
  context.strokeRect(left, top, right - left, bottom - top)

  label(context, 'LIVING ROOM', 600, 350, { size: 34, weight: 'bold', align: 'center' })
  label(context, '31.92 m2', 600, 395, { size: 28, align: 'center' })
  label(context, 'CEILING 2.70 m', 600, 445, { size: 22, align: 'center', color: MUTED })

  dimension(context, left, 135, right, 135, '7.60 m', 600, 115)
  dimension(context, 155, top, 155, bottom, '4.20 m', 120, 400, -Math.PI / 2)
  dimension(context, left, 665, right, 665, '7.60 m', 600, 700)
  dimension(context, 1045, top, 1045, bottom, '4.20 m', 1080, 400, Math.PI / 2)

  label(context, 'DIMENSIONS IN METRES', 54, 754, { size: 20, weight: 'bold', color: MUTED })
  label(context, 'N', 1090, 100, { size: 25, weight: 'bold', align: 'center' })
  context.strokeStyle = BLACK
  context.lineWidth = 3
  context.beginPath()
  context.moveTo(1090, 158)
  context.lineTo(1090, 112)
  context.lineTo(1080, 128)
  context.moveTo(1090, 112)
  context.lineTo(1100, 128)
  context.stroke()
  return canvas
}

function irregularScaledRoom() {
  const { canvas, context } = page(1400, 900, 'FLOOR PLAN - IRREGULAR SCALED ROOM')
  const points = [
    [210, 180],
    [910, 180],
    [910, 390],
    [700, 390],
    [700, 670],
    [210, 670],
  ]

  context.fillStyle = '#f8fafc'
  context.strokeStyle = BLACK
  context.lineWidth = 10
  context.beginPath()
  context.moveTo(points[0][0], points[0][1])
  for (const [x, y] of points.slice(1)) context.lineTo(x, y)
  context.closePath()
  context.fill()
  context.stroke()

  label(context, 'STUDIO', 480, 365, { size: 36, weight: 'bold', align: 'center' })
  label(context, 'CEILING 2.80 m', 480, 410, { size: 22, align: 'center', color: MUTED })

  dimension(context, 210, 125, 910, 125, '10.00 m', 560, 104)
  dimension(context, 970, 180, 970, 390, '3.00 m', 1005, 285, Math.PI / 2)
  dimension(context, 700, 445, 910, 445, '3.00 m', 805, 478)
  dimension(context, 755, 390, 755, 670, '4.00 m', 790, 530, Math.PI / 2)
  dimension(context, 210, 725, 700, 725, '7.00 m', 455, 760)
  dimension(context, 150, 180, 150, 670, '7.00 m', 115, 425, -Math.PI / 2)

  label(context, 'SCALE 1:50', 1060, 640, { size: 24, weight: 'bold' })
  label(context, 'SCALE BAR', 1060, 680, { size: 18, color: MUTED })
  context.strokeStyle = BLACK
  context.lineWidth = 4
  context.beginPath()
  context.moveTo(140, 790)
  context.lineTo(420, 790)
  for (let index = 0; index <= 4; index += 1) {
    const x = 140 + index * 70
    context.moveTo(x, 775)
    context.lineTo(x, 805)
    label(context, String(index), x, 835, { size: 18, align: 'center' })
  }
  context.stroke()
  label(context, 'metres', 455, 798, { size: 18, color: MUTED })
  label(context, 'DIMENSIONS IN METRES', 1060, 720, { size: 18, weight: 'bold', color: MUTED })
  return canvas
}

function nonFloorPlan() {
  const { canvas, context } = page(1100, 700, 'PROPERTY VIEWING CHECKLIST')
  label(context, '18 SEPTEMBER 2026', 70, 105, { size: 19, weight: 'bold', color: MUTED })
  label(context, 'RIVERSIDE APARTMENT', 70, 165, { size: 34, weight: 'bold' })
  label(context, 'Inspection notes', 70, 220, { size: 26, weight: 'bold', color: BLUE })

  const notes = [
    'Natural light is strongest in the afternoon.',
    'Heating and ventilation controls were demonstrated.',
    'Kitchen appliances are included in the inventory.',
    'Keys will be released after contract completion.',
  ]
  notes.forEach((note, index) => {
    const y = 280 + index * 62
    context.fillStyle = BLUE
    context.beginPath()
    context.arc(82, y - 7, 6, 0, Math.PI * 2)
    context.fill()
    label(context, note, 108, y, { size: 22 })
  })

  context.fillStyle = '#fef2f2'
  context.strokeStyle = RED
  context.lineWidth = 3
  context.fillRect(70, 545, 960, 80)
  context.strokeRect(70, 545, 960, 80)
  label(context, 'REFERENCE PAGE ONLY - NO FLOOR PLAN OR MEASURED DRAWING', 550, 595, {
    size: 21,
    weight: 'bold',
    align: 'center',
    color: RED,
  })
  return canvas
}

const fixtures = [
  ['complete-rectangle.png', completeRectangle()],
  ['irregular-scaled-room.png', irregularScaledRoom()],
  ['not-floor-plan.png', nonFloorPlan()],
]

await Promise.all(
  fixtures.map(async ([name, canvas]) => {
    const bytes = await canvas.encode('png')
    await writeFile(path.join(outputDir, name), bytes)
  }),
)
