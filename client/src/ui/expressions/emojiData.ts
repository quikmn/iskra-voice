// A compact set of standard emoji for the picker: "emoji shortcode extra search words".
// Shortcodes also work when typed as :shortcode: in a message.

const RAW: Record<string, string> = {
  Smileys: `
😀 grinning smile happy
😃 smiley happy joy
😄 smile happy laugh
😁 grin teeth
😆 laughing satisfied haha
😅 sweat_smile phew relief
🤣 rofl rolling laugh
😂 joy tears laugh lol
🙂 slight_smile
🙃 upside_down silly
😉 wink
😊 blush happy
😇 innocent halo angel
🥰 smiling_hearts love
😍 heart_eyes love crush
🤩 star_struck wow
😘 kissing_heart kiss
😋 yum tasty delicious
😛 tongue
😜 stuck_out_tongue_winking_eye crazy
🤪 zany crazy goofy
😝 squinting_tongue
🤑 money_mouth rich
🤗 hugging hug
🤭 hand_over_mouth oops
🤫 shushing quiet secret
🤔 thinking hmm think
🤐 zipper_mouth
🤨 raised_eyebrow suspicious
😐 neutral_face meh
😑 expressionless
😶 no_mouth silent
😏 smirk
😒 unamused
🙄 rolling_eyes eyeroll
😬 grimacing awkward
😮‍💨 exhaling sigh
🤥 lying pinocchio
😌 relieved
😔 pensive sad
😪 sleepy
🤤 drooling
😴 sleeping zzz tired
😷 mask sick
🤒 thermometer_face sick
🤕 head_bandage hurt
🤢 nauseated sick gross
🤮 vomiting sick
🥵 hot sweating
🥶 cold freezing
🥴 woozy dizzy drunk
😵 dizzy_face
🤯 exploding_head mind_blown
🤠 cowboy yeehaw
🥳 partying party celebrate
🥸 disguised
😎 sunglasses cool
🤓 nerd glasses
🧐 monocle
😕 confused
😟 worried
🙁 slight_frown
😮 open_mouth wow surprised
😯 hushed
😲 astonished shocked
😳 flushed embarrassed
🥺 pleading puppy_eyes
😦 frowning
😧 anguished
😨 fearful scared
😰 anxious_sweat
😥 sad_relieved
😢 cry sad tear
😭 sob crying
😱 scream fear
😖 confounded
😣 persevere
😞 disappointed
😓 sweat
😩 weary
😫 tired_face
🥱 yawning bored
😤 triumph huff
😡 rage angry mad
😠 angry mad
🤬 cursing swearing
😈 smiling_imp devil
👿 imp angry_devil
💀 skull dead lol
☠️ skull_crossbones
💩 poop
🤡 clown
👹 ogre
👻 ghost boo
👽 alien
🤖 robot bot
😺 smiley_cat
😹 joy_cat
😻 heart_eyes_cat
🙈 see_no_evil monkey
🙉 hear_no_evil monkey
🙊 speak_no_evil monkey`,
  People: `
👋 wave hello hi bye
🤚 raised_back_of_hand
✋ raised_hand high_five stop
🖖 vulcan spock
👌 ok_hand perfect
🤌 pinched_fingers italian
🤏 pinching small
✌️ victory peace
🤞 crossed_fingers luck
🤟 love_you
🤘 metal rock horns
🤙 call_me shaka
👈 point_left
👉 point_right
👆 point_up
👇 point_down
☝️ point_up_2
👍 thumbsup +1 yes like
👎 thumbsdown -1 no dislike
✊ fist
👊 punch fist_bump
🤛 left_fist
🤜 right_fist
👏 clap applause
🙌 raised_hands hooray
👐 open_hands
🤲 palms_up
🤝 handshake deal
🙏 pray please thanks
✍️ writing
💪 muscle strong flex
🦾 mechanical_arm
🧠 brain smart
👀 eyes look
👁️ eye
👅 tongue_out
👄 lips
💋 kiss_mark
👶 baby
🧒 child
👦 boy
👧 girl
🧑 person
👨 man
👩 woman
🧓 older_person
👴 old_man
👵 old_woman
🙋 raising_hand
🤷 shrug idk
🤦 facepalm
🙇 bow
💁 tipping_hand
🙅 no_gesture
🙆 ok_gesture
🧑‍💻 technologist coder programmer
🧑‍🍳 cook chef
🧑‍🎓 student
🧑‍🏫 teacher
🧑‍🚀 astronaut
🥷 ninja
🦸 superhero
🧙 mage wizard
🧛 vampire
🧟 zombie
🕺 man_dancing dance
💃 dancer dance
🏃 runner run
🚶 walking
🧘 yoga meditate`,
  Nature: `
🐶 dog puppy
🐱 cat kitty
🐭 mouse
🐹 hamster
🐰 rabbit bunny
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger
🦁 lion
🐮 cow
🐷 pig
🐸 frog
🐵 monkey_face
🐔 chicken
🐧 penguin
🐦 bird
🐤 baby_chick
🦆 duck
🦅 eagle
🦉 owl
🦇 bat
🐺 wolf
🐗 boar
🐴 horse
🦄 unicorn
🐝 bee
🐛 bug
🦋 butterfly
🐌 snail
🐞 ladybug
🐢 turtle
🐍 snake
🦖 t_rex dinosaur
🦕 sauropod dinosaur
🐙 octopus
🦑 squid
🦀 crab
🐠 tropical_fish
🐟 fish
🐬 dolphin
🐳 whale
🦈 shark
🐊 crocodile
🐘 elephant
🦒 giraffe
🦘 kangaroo
🐿️ chipmunk squirrel
🦔 hedgehog
🌵 cactus
🎄 christmas_tree
🌲 evergreen_tree
🌳 tree
🌴 palm_tree
🌱 seedling plant
🌿 herb
🍀 four_leaf_clover luck
🍁 maple_leaf
🍂 fallen_leaf autumn
🍄 mushroom
🌷 tulip
🌹 rose
🌻 sunflower
🌸 cherry_blossom
💐 bouquet flowers
🌞 sun_with_face
🌝 full_moon_face
🌙 crescent_moon night
⭐ star
🌟 star2 glowing
✨ sparkles
⚡ zap lightning
🔥 fire lit hot
💥 boom explosion
☄️ comet
☀️ sunny sun
⛅ partly_sunny
☁️ cloud
🌧️ rain
⛈️ thunderstorm
❄️ snowflake cold
☃️ snowman
🌈 rainbow
🌊 ocean wave
💧 droplet water`,
  Food: `
🍏 green_apple
🍎 apple
🍐 pear
🍊 tangerine orange
🍋 lemon
🍌 banana
🍉 watermelon
🍇 grapes
🍓 strawberry
🫐 blueberries
🍒 cherries
🍑 peach
🥭 mango
🍍 pineapple
🥥 coconut
🥝 kiwi
🍅 tomato
🥑 avocado
🍆 eggplant
🥔 potato
🥕 carrot
🌽 corn
🌶️ hot_pepper spicy
🥦 broccoli
🍞 bread
🥐 croissant
🥨 pretzel
🧀 cheese
🥚 egg
🍳 cooking fried_egg
🥞 pancakes
🥓 bacon
🍗 poultry_leg chicken
🍖 meat
🌭 hotdog
🍔 hamburger burger
🍟 fries
🍕 pizza
🥪 sandwich
🌮 taco
🌯 burrito
🥗 salad
🍝 spaghetti pasta
🍜 ramen noodles
🍣 sushi
🍤 fried_shrimp
🍙 rice_ball
🍚 rice
🍦 icecream
🍩 doughnut donut
🍪 cookie
🎂 birthday cake
🍰 cake
🧁 cupcake
🍫 chocolate_bar
🍬 candy
🍭 lollipop
🍿 popcorn
☕ coffee
🍵 tea
🧃 juice
🥤 cup_with_straw soda
🍺 beer
🍻 beers cheers
🍷 wine
🍸 cocktail
🥂 champagne toast
🧊 ice`,
  Activities: `
⚽ soccer football
🏀 basketball
🏈 american_football
⚾ baseball
🎾 tennis
🏐 volleyball
🏉 rugby
🎱 8ball pool
🏓 ping_pong
🏸 badminton
🏒 hockey
⛳ golf
🏹 bow_and_arrow
🎣 fishing
🥊 boxing_glove
🥋 martial_arts
🛹 skateboard
⛸️ ice_skate
🎿 ski
🏂 snowboarder
🏋️ weight_lifting gym
🚴 biking
🏆 trophy win
🥇 first_place gold
🥈 second_place silver
🥉 third_place bronze
🏅 medal
🎖️ military_medal
🎮 video_game gaming controller
🕹️ joystick
🎲 game_die dice
♟️ chess_pawn chess
🧩 jigsaw puzzle
🎯 dart bullseye target
🎳 bowling
🎰 slot_machine
🎨 art palette
🎬 clapper movie
🎤 microphone sing karaoke
🎧 headphones music
🎼 musical_score
🎹 musical_keyboard piano
🥁 drum
🎷 saxophone
🎺 trumpet
🎸 guitar
🎻 violin
🎉 tada party celebrate
🎊 confetti_ball
🎈 balloon
🎁 gift present
🎀 ribbon
🪅 pinata
🎃 jack_o_lantern halloween
🎆 fireworks
🎇 sparkler`,
  Travel: `
🚗 car
🚕 taxi
🚌 bus
🏎️ race_car
🚓 police_car
🚑 ambulance
🚒 fire_engine
🚚 truck
🚜 tractor
🏍️ motorcycle
🚲 bike bicycle
🛴 scooter
🚂 steam_locomotive train
🚆 train2
✈️ airplane plane
🚀 rocket launch
🛸 flying_saucer ufo
🚁 helicopter
⛵ sailboat
🚢 ship
⚓ anchor
🗺️ world_map
🗽 statue_of_liberty
🏰 castle
🏯 japanese_castle
🎡 ferris_wheel
🎢 roller_coaster
🏖️ beach
🏝️ island
🏔️ mountain_snow
🌋 volcano
⛺ tent camping
🏠 house home
🏡 house_garden
🏢 office
🏥 hospital
🏫 school
🌃 night_with_stars
🌅 sunrise
🌍 earth_africa globe world
🌎 earth_americas
🌏 earth_asia
🪐 ringed_planet saturn`,
  Objects: `
⌚ watch
📱 iphone phone mobile
💻 computer laptop
⌨️ keyboard
🖥️ desktop_computer pc
🖱️ mouse_computer
💾 floppy_disk save
💿 cd
📷 camera
📹 video_camera
📺 tv
📻 radio
⏰ alarm_clock
⏳ hourglass waiting
🔋 battery
🔌 electric_plug
💡 bulb idea
🔦 flashlight
🕯️ candle
💸 money_with_wings
💵 dollar money
💰 moneybag
💎 gem diamond
🔧 wrench
🔨 hammer
🛠️ tools
⚙️ gear settings
🧲 magnet
💣 bomb
🔪 knife
🗡️ dagger
⚔️ crossed_swords
🛡️ shield
🔮 crystal_ball
🧪 test_tube science
🔭 telescope
🔬 microscope
💊 pill
🩹 bandage
🧸 teddy_bear
🛒 shopping_cart
📦 package box
📫 mailbox
✉️ envelope mail
📝 memo note
📅 calendar date
📌 pushpin pin
📎 paperclip
✂️ scissors
🔒 lock
🔓 unlock
🔑 key
🗝️ old_key
📚 books
📖 book read
🔔 bell notification
🔕 no_bell mute
📣 mega announcement
💬 speech_balloon chat
💭 thought_balloon
🗯️ anger_bubble`,
  Symbols: `
❤️ heart love red_heart
🧡 orange_heart
💛 yellow_heart
💚 green_heart
💙 blue_heart
💜 purple_heart
🖤 black_heart
🤍 white_heart
🤎 brown_heart
💔 broken_heart
❣️ heart_exclamation
💕 two_hearts
💞 revolving_hearts
💓 heartbeat
💗 heartpulse
💖 sparkling_heart
💘 cupid
💝 gift_heart
💯 100 hundred perfect
💢 anger
💤 zzz sleep
💫 dizzy
💦 sweat_drops
✅ white_check_mark check done yes
☑️ ballot_box_with_check
✔️ heavy_check_mark
❌ x cross no wrong
❎ negative_squared_cross_mark
➕ plus
➖ minus
➗ divide
✖️ multiply
❓ question
❔ grey_question
❗ exclamation
‼️ bangbang
⁉️ interrobang
⚠️ warning
🚫 no_entry_sign forbidden
⛔ no_entry
🔞 underage
♻️ recycle
🔴 red_circle
🟠 orange_circle
🟡 yellow_circle
🟢 green_circle
🔵 blue_circle
🟣 purple_circle
⚫ black_circle
⚪ white_circle
🟥 red_square
🟩 green_square
🟦 blue_square
⬆️ arrow_up
⬇️ arrow_down
⬅️ arrow_left
➡️ arrow_right
🔄 arrows_counterclockwise refresh
🔁 repeat
▶️ arrow_forward play
⏸️ pause
⏹️ stop
🎵 musical_note music
🎶 notes music
🔊 loud_sound volume
🔇 mute
🆗 ok
🆒 cool_button
🆕 new
🆘 sos help
©️ copyright
®️ registered
™️ tm trademark
#️⃣ hash
0️⃣ zero
1️⃣ one
2️⃣ two
3️⃣ three
4️⃣ four
5️⃣ five
6️⃣ six
7️⃣ seven
8️⃣ eight
9️⃣ nine
🔟 keycap_ten
🏁 checkered_flag finish
🚩 triangular_flag
🏳️ white_flag
🏴 black_flag
🏳️‍🌈 rainbow_flag pride`,
}

export interface StandardEmoji {
  char: string
  /** Primary shortcode, used for :shortcode: and shown in the picker. */
  name: string
  keywords: string[]
}

export const EMOJI_CATEGORIES: { name: string; icon: string; emoji: StandardEmoji[] }[] = Object.entries(RAW).map(([name, block]) => {
  const emoji = block.trim().split('\n').map((line) => {
    const [char, short, ...keywords] = line.trim().split(/\s+/)
    return { char, name: short, keywords }
  })
  return { name, icon: emoji[0].char, emoji }
})

export const STANDARD_EMOJI: StandardEmoji[] = EMOJI_CATEGORIES.flatMap((c) => c.emoji)

export const BY_SHORTCODE: Map<string, string> = new Map(STANDARD_EMOJI.map((e) => [e.name, e.char]))
